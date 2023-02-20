import { Job } from 'bullmq';
import { ethers } from 'ethers';
import { Storage } from 'firebase-admin/lib/storage/storage';
import { Redis } from 'ioredis';
import * as ReadLine from 'readline';
import Redlock, { ExecutionError, RedlockAbortSignal, ResourceLockedError } from 'redlock';

import { ChainId, OrderStatusEvent } from '@infinityxyz/lib/types/core';
import { sleep } from '@infinityxyz/lib/utils';

import { config } from '@/config';
import { streamQueryWithRef } from '@/lib/firestore';
import { MatchingEngine } from '@/lib/matching-engine/v1';
import { OrderbookV1 as OB } from '@/lib/orderbook';
import { Order } from '@/lib/orderbook/v1';
import { ProcessOptions, WithTiming } from '@/lib/process/types';

import { AbstractOrderRelay } from '../order-relay.abstract';
import { OrderStatusEventSyncCursor, OrderbookSnapshotOrder } from './types';

export interface SnapshotMetadata {
  bucket: string;
  file: string;
  chainId: ChainId;
  numOrders: number;
  timestamp: number;
  collection: string;
}

export interface JobData {
  /**
   * the order id
   */
  id: string;
  orderData: OB.Types.OrderData;
}

type JobResult = WithTiming<{
  id: string;
  successful: boolean;
}>;

export class OrderRelay extends AbstractOrderRelay<OB.Order, OB.Types.OrderData, JobData, JobResult> {
  protected _version = 'v1';

  constructor(
    protected _matchingEngine: MatchingEngine,
    protected _firestore: FirebaseFirestore.Firestore,
    protected _storage: Storage,
    protected _redlock: Redlock,
    orderbook: OB.Orderbook,
    db: Redis,
    public readonly collectionAddress: string,
    options?: Partial<ProcessOptions>
  ) {
    const version = 'v1';
    super(orderbook, db, `order-relay:${version}:collection:${collectionAddress}`, options);

    if (!this.collectionAddress || !ethers.utils.isAddress(this.collectionAddress)) {
      throw new Error('Invalid collection address');
    }
    this._version = version;
  }

  async processJob(job: Job<JobData, JobResult, string>): Promise<JobResult> {
    const start = Date.now();

    const orderParams = Order.getOrderParams(job.data.id, config.env.chainId, job.data.orderData.order);
    const order = new Order(orderParams);
    let successful;
    try {
      await this._orderbook.checkOrder(order);
      await this._orderbook.save(job.data.orderData);
      if (job.data.orderData.status === 'active') {
        await this._matchingEngine.add({
          id: job.data.id,
          order: orderParams
        });
      }
      successful = true;
    } catch (err) {
      this.error(`Failed to process order ${job.data.id}: ${(err as Error).message}`);
      successful = false;
    }

    return {
      id: job.data.id,
      successful,
      timing: {
        created: job.timestamp,
        started: start,
        completed: Date.now()
      }
    };
  }

  public async run() {
    const orderRelayLock = `order-relay:chain:${config.env.chainId}:collection:${this.collectionAddress}:lock`;
    const lockDuration = 15_000;
    let failedAttempts = 0;

    while (failedAttempts < 5) {
      try {
        const lockPromise = this._redlock.using([orderRelayLock], lockDuration, async (signal) => {
          this.log(`Acquired lock`);
          failedAttempts = 0;
          const promises = [];
          const runPromise = super._run();
          promises.push(runPromise);

          /**
           * sync and maintain the orderbook
           */
          const syncPromise = this._sync(signal);
          promises.push(syncPromise);
          const abortPromise = new Promise((resolve, reject) => {
            signal.onabort = () => {
              reject(new Error('Lock aborted'));
            };
          });
          promises.push(abortPromise);

          await Promise.all(promises);
        });

        await lockPromise;
      } catch (err) {
        failedAttempts += 1;
        if (err instanceof ExecutionError) {
          this.warn(`Failed to acquire lock, another instance is syncing. Attempt: ${failedAttempts}`);
        } else {
          this.error(`Unknown error occurred. Attempt: ${failedAttempts} ${JSON.stringify(err)}`);
        }
        await sleep(lockDuration / 3);
      }
    }

    throw new Error('Failed to acquire lock after 5 attempts');
  }

  protected async _sync(signal: RedlockAbortSignal) {
    // to begin syncing we need to make sure we are the only instance syncing redis
    const syncCursorKey = `order-relay:chain:${config.env.chainId}:collection:${this.collectionAddress}:order-events:sync-cursor`;
    const encodedSyncCursor = await this._db.get(syncCursorKey);

    let syncCursor: OrderStatusEventSyncCursor | undefined;

    try {
      syncCursor = JSON.parse(encodedSyncCursor ?? '') as OrderStatusEventSyncCursor;
    } catch (err) {
      // failed to find cursor
    }

    const saveCursor = async (cursor: OrderStatusEventSyncCursor) => {
      syncCursor = cursor;
      await this._db.set(syncCursorKey, JSON.stringify(cursor));
    };

    /**
     * if we failed to find a cursor, load the most recent snapshot
     */
    if (!syncCursor) {
      ({ syncCursor } = await this._loadSnapshot(signal));
      await saveCursor(syncCursor);
    }

    /**
     * process all status event changes since the last
     * event that was processed
     */
    const startTimestamp = syncCursor.timestamp;
    const endTimestamp = Date.now();
    const iterator = this._syncEvents(syncCursor);
    this.emit('orderbookSyncing');
    for await (const { syncCursor, numEvents, complete } of iterator) {
      this._checkSignal(signal);
      await saveCursor(syncCursor);

      if (!complete) {
        this.emit('orderbookSyncingProgress', {
          numEventsProcessed: numEvents,
          timestampLastItem: syncCursor.timestamp,
          percentComplete:
            Math.floor(((syncCursor.timestamp - startTimestamp) / (endTimestamp - startTimestamp)) * 100_000) / 1000
        });
      } else {
        this.emit('orderbookSynced', {
          numEventsProcessed: numEvents,
          timing: {
            created: endTimestamp,
            started: endTimestamp,
            completed: Date.now()
          }
        });
      }
    }

    /**
     * maintain the orderbook by processing events as they occur
     */
    await this._maintainSync(signal, syncCursor, saveCursor);
  }

  protected _maintainSync(
    signal: RedlockAbortSignal,
    initialSyncCursor: OrderStatusEventSyncCursor,
    saveCursor: (cursor: OrderStatusEventSyncCursor) => Promise<void>
  ) {
    const orderStatusEvents = this._firestore.collectionGroup(
      'orderStatusChanges'
    ) as FirebaseFirestore.CollectionGroup<OrderStatusEvent>;

    const orderStatusEventsQuery = orderStatusEvents
      .where('chainId', '==', config.env.chainId)
      .where('collection', '==', this.collectionAddress)
      .where('isMostRecent', '==', true)
      .orderBy('timestamp', 'asc')
      .orderBy('id', 'asc')
      .startAfter(initialSyncCursor.timestamp, initialSyncCursor.eventId);

    type Acc = {
      added: FirebaseFirestore.DocumentChange<OrderStatusEvent>[];
      removed: FirebaseFirestore.DocumentChange<OrderStatusEvent>[];
      modified: FirebaseFirestore.DocumentChange<OrderStatusEvent>[];
    };

    const syncCursor = initialSyncCursor;

    return new Promise((reject) => {
      const cancel = orderStatusEventsQuery.onSnapshot(
        async (snapshot) => {
          try {
            this._checkSignal(signal);
            this.log(`Received ${snapshot.docChanges().length} order status events`);

            const eventsByType = snapshot.docChanges().reduce(
              (acc: Acc, item) => {
                switch (item.type) {
                  case 'added': {
                    acc.added.push(item);
                    break;
                  }
                  case 'removed': {
                    acc.removed.push(item);
                    break;
                  }
                  case 'modified': {
                    acc.modified.push(item);
                  }
                }
                return acc;
              },
              { added: [], modified: [], removed: [] } as Acc
            );

            if (eventsByType.modified.length > 0) {
              const modifiedEvents = eventsByType.modified.map((item) => item.doc.ref.id).join(',');
              this.error(
                `Received modified order status event. Expect most recent status events to be immutable. Ids: ${modifiedEvents}`
              );
            }

            const jobData = eventsByType.added.map((item) => {
              const data = item.doc.data();
              this.log(`Received order status event for order ${data.orderId}`);
              return {
                id: data.orderId,
                orderData: {
                  id: data.orderId,
                  order: data.order,
                  status: data.status,
                  source: data.source,
                  sourceOrder: data.sourceOrder,
                  gasUsage: data.gasUsage
                }
              };
            });

            await this.add(jobData);

            const lastEvent = snapshot.docs[snapshot.docs.length - 1]?.data?.();

            if (lastEvent) {
              this._checkSignal(signal);
              syncCursor.timestamp = lastEvent.timestamp;
              syncCursor.eventId = lastEvent.id;
              syncCursor.orderId = lastEvent.orderId;
              await saveCursor(syncCursor);
            }
          } catch (err) {
            if (err instanceof ResourceLockedError || err instanceof ExecutionError) {
              cancel();
              return;
            }
          }
        },
        (err) => {
          this.error(`Order status event stream failed ${err.message}`);
          reject(err);
        }
      );
    });
  }

  /**
   * eventOnlySync will process all order status events
   * since the last order status event snapshot processed
   */
  protected async *_syncEvents(syncCursor: OrderStatusEventSyncCursor, syncUntil: number = Date.now()) {
    const orderStatusEvents = this._firestore.collectionGroup(
      'orderStatusChanges'
    ) as FirebaseFirestore.CollectionGroup<OrderStatusEvent>;

    const orderStatusEventsQuery = orderStatusEvents
      .where('chainId', '==', config.env.chainId)
      .where('collection', '==', this.collectionAddress)
      .where('isMostRecent', '==', true)
      .where('timestamp', '<=', syncUntil)
      .orderBy('timestamp', 'asc')
      .orderBy('id', 'asc')
      .startAfter(syncCursor.timestamp, syncCursor.eventId);

    const cursor: OrderStatusEventSyncCursor = syncCursor;

    const stream = streamQueryWithRef(
      orderStatusEventsQuery,
      (lastItem) => {
        if (lastItem) {
          cursor.timestamp = lastItem.timestamp;
          cursor.orderId = lastItem.orderId;
          cursor.eventId = lastItem.id;
        }

        return [cursor.timestamp, cursor.eventId];
      },
      { pageSize: 300 }
    );

    let numEvents = 0;
    for await (const { data } of stream) {
      await this.add({
        id: data.orderId,
        orderData: {
          id: data.orderId,
          order: data.order,
          status: data.status,
          source: data.source,
          sourceOrder: data.sourceOrder,
          gasUsage: data.gasUsage
        }
      });

      numEvents += 1;
      if (numEvents % 300 === 0) {
        yield { syncCursor: cursor, numEvents, complete: false };
      }
    }

    yield { syncCursor: cursor, numEvents, complete: true };
  }

  protected async _loadSnapshot(signal: RedlockAbortSignal): Promise<{ syncCursor: OrderStatusEventSyncCursor }> {
    const startTime = Date.now();

    const result = await this._getSnapshotMetadata();

    this._checkSignal(signal);
    let numOrders = 0;
    let timestamp = 0;
    if (result) {
      const { bucket, file, timestamp: snapshotTimestamp } = result;
      timestamp = snapshotTimestamp;
      const orderIterator = this._getSnapshot({ bucket, file });
      this.emit('snapshotLoading');

      let page: JobData[] = [];
      for await (const item of orderIterator) {
        // the snapshot is assumed to contain only active orders
        page.push({
          id: item.id,
          orderData: {
            ...item,
            status: 'active'
          }
        });
        // await this.add({
        // });
        numOrders += 1;
        if (page.length % 1000 === 0) {
          this._checkSignal(signal);
          await this.add(page);
          page = [];
        }
      }

      if (page.length > 0) {
        this._checkSignal(signal);
        await this.add(page);
        page = [];
      }
    }
    const endLoadTime = Date.now();
    this.emit('snapshotLoaded', {
      numOrders,
      timing: {
        created: startTime,
        started: startTime,
        completed: endLoadTime
      }
    });

    const cursor: OrderStatusEventSyncCursor = {
      timestamp: timestamp,
      orderId: '',
      eventId: ''
    };

    return { syncCursor: cursor };
  }

  protected async *_getSnapshot(source: { bucket: string; file: string }): AsyncGenerator<OrderbookSnapshotOrder> {
    const cloudStorageFile = this._storage.bucket(source.bucket).file(source.file);
    const snapshotReadStream = cloudStorageFile.createReadStream();

    const rl = ReadLine.createInterface({
      input: snapshotReadStream,
      crlfDelay: Infinity
    });

    for await (const line of rl) {
      try {
        const order = JSON.parse(line) as OrderbookSnapshotOrder;
        yield order;
      } catch (err) {
        if (err instanceof Error) {
          this.error(`Error parsing order from snapshot: ${err.message}`);
        } else {
          this.error(`Error parsing order from snapshot: ${err}`);
        }
      }
    }
  }

  protected _checkSignal(signal: RedlockAbortSignal) {
    if (signal.aborted) {
      throw signal.error;
    }
  }

  protected async _getSnapshotMetadata(): Promise<SnapshotMetadata | null> {
    const orderSnapshotsRef = this._firestore.collection(
      'orderSnapshots'
    ) as FirebaseFirestore.CollectionReference<SnapshotMetadata>;

    const mostRecentSnapshotQuery = orderSnapshotsRef
      .where('chainId', '==', config.env.chainId)
      .where('collection', '==', this.collectionAddress)
      .orderBy('timestamp', 'desc')
      .limit(1);

    const snap = await mostRecentSnapshotQuery.get();

    const snapshotMetadata = snap.docs[0]?.data?.();

    if (!snapshotMetadata) {
      this.warn('No snapshot found');
      return null;
    }

    return snapshotMetadata;
  }
}
