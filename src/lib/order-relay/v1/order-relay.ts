import { BulkJobOptions, Job } from 'bullmq';
import { Storage } from 'firebase-admin/lib/storage/storage';
import { Redis } from 'ioredis';
import * as ReadLine from 'readline';
import Redlock, { ExecutionError, RedlockAbortSignal } from 'redlock';

import { ChainId, OrderStatusEvent } from '@infinityxyz/lib/types/core';

import { logger } from '@/common/logger';
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
    options?: Partial<ProcessOptions>
  ) {
    const version = 'v1';
    super(orderbook, db, `order-relay:${version}`, options);
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
    const orderSyncKey = 'order-relay:lock';
    const lockDuration = 15_000;

    /**
     * start processing jobs from the queue
     */
    const runPromise = super._run().catch((err: Error) => {
      logger.error('order-relay', `Unexpected error: ${err.message}`);
    });
    const syncPromise = this._redlock
      .using([orderSyncKey], lockDuration, async (signal) => {
        /**
         * sync and maintain the orderbook
         */
        await this._sync(signal);
      })
      .catch((err) => {
        if (err instanceof ExecutionError) {
          logger.warn('order-relay', 'Failed to acquire lock, another instance is syncing');
        } else {
          throw err;
        }
      });

    await Promise.all([runPromise, syncPromise]);
  }

  async add(data: JobData | JobData[]): Promise<void> {
    const arr = Array.isArray(data) ? data : [data];
    const jobs: {
      name: string;
      data: JobData;
      opts?: BulkJobOptions | undefined;
    }[] = arr.map((item) => {
      return {
        name: item.id,
        data: item
      };
    });
    await this._queue.addBulk(jobs);
  }

  protected async _sync(signal: RedlockAbortSignal) {
    // to begin syncing we need to make sure we are the only instance syncing redis
    const syncCursorKey = 'order-relay:order-events:sync-cursor';
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
    const iterator = this._syncEvents(signal, syncCursor);
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
      orderStatusEventsQuery.onSnapshot(
        async (snapshot) => {
          this._checkSignal(signal);
          logger.log('order-relay', `Received ${snapshot.docChanges().length} order status events`);

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
            logger.error(
              'order-relay',
              `Received modified order status event. Expect most recent status events to be immutable. Ids: ${modifiedEvents}`
            );
          }

          const jobData = eventsByType.added.map((item) => {
            const data = item.doc.data();
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
        },
        (err) => {
          // TODO handle this more robustly
          logger.error('order-relay', `Order status event stream failed ${err.message}`);
          reject(err);
        }
      );
    });
  }

  /**
   * eventOnlySync will process all order status events
   * since the last order status event snapshot processed
   */
  protected async *_syncEvents(
    signal: RedlockAbortSignal,
    syncCursor: OrderStatusEventSyncCursor,
    syncUntil: number = Date.now()
  ) {
    const orderStatusEvents = this._firestore.collectionGroup(
      'orderStatusChanges'
    ) as FirebaseFirestore.CollectionGroup<OrderStatusEvent>;

    const orderStatusEventsQuery = orderStatusEvents
      .where('chainId', '==', config.env.chainId)
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
      this._checkSignal(signal);
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

    const { bucket, file, timestamp } = await this._getSnapshotMetadata();

    this._checkSignal(signal);
    const orderIterator = this._getSnapshot({ bucket, file });
    this.emit('snapshotLoading');

    let numOrders = 0;
    for await (const item of orderIterator) {
      // the snapshot is assumed to contain only active orders
      // await this.add({ id: item. ...item, status: 'active' });
      await this.add({
        id: item.id,
        orderData: {
          ...item,
          status: 'active'
        }
      });
      numOrders += 1;
      this._checkSignal(signal);
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
          logger.error(`order-relay`, `Error parsing order from snapshot: ${err.message}`);
        } else {
          logger.error(`order-relay`, `Error parsing order from snapshot: ${err}`);
        }
      }
    }
  }

  protected _checkSignal(signal: RedlockAbortSignal) {
    if (signal.aborted) {
      throw signal.error;
    }
  }

  protected async _getSnapshotMetadata(): Promise<SnapshotMetadata> {
    const orderSnapshotsRef = this._firestore.collection(
      'orderSnapshots'
    ) as FirebaseFirestore.CollectionReference<SnapshotMetadata>;

    const mostRecentSnapshotQuery = orderSnapshotsRef
      .where('chainId', '==', config.env.chainId)
      .orderBy('timestamp', 'desc')
      .limit(1);

    const snap = await mostRecentSnapshotQuery.get();

    const snapshotMetadata = snap.docs[0]?.data?.();

    if (!snapshotMetadata) {
      throw new Error('No snapshot metadata found');
    }

    return snapshotMetadata;
  }
}
