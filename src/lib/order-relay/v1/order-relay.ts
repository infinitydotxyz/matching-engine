import { BulkJobOptions, Job } from 'bullmq';
import { Storage } from 'firebase-admin/lib/storage/storage';
import { Redis } from 'ioredis';
import * as ReadLine from 'readline';
import Redlock, { ExecutionError, RedlockAbortSignal } from 'redlock';

import { ChainId, ChainOBOrder, OrderStatusEvent, RawOrderWithoutError } from '@infinityxyz/lib/types/core';

import { logger } from '@/common/logger';
import { config } from '@/config';
import { streamQueryWithRef } from '@/lib/firestore';
import { MatchingEngine } from '@/lib/matching-engine/v1';
import { OrderbookV1 as OB } from '@/lib/orderbook';
import { Order } from '@/lib/orderbook/v1';
import { Status } from '@/lib/orderbook/v1/types';
import { ProcessOptions, WithTiming } from '@/lib/process/types';

import { AbstractOrderRelay } from '../order-relay.abstract';
import { OrderStatusEventSyncCursor } from './types';

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
  order: ChainOBOrder;
  status: Status;
}

type JobResult = unknown;

export class OrderRelay extends AbstractOrderRelay<OB.Order, OB.Types.Status, JobData, JobResult> {
  constructor(
    protected _matchingEngine: MatchingEngine,
    protected _firestore: FirebaseFirestore.Firestore,
    protected _storage: Storage,
    protected _redlock: Redlock,
    orderbook: OB.Orderbook,
    db: Redis,
    queueName: string,
    options?: Partial<ProcessOptions>
  ) {
    super(orderbook, db, queueName, options);
  }

  processJob(job: Job<JobData, JobResult, string>): Promise<JobResult> {
    /**
     * take an order change
     * 1. Update orderbook with order (create/change status/delete)
     * 2. 'active' => submit to matching engine to process
     * 3. non-'active' => remove from matching engine queue, remove from execution queue
     *
     * active => save to orderbook + submit to matching engine
     * non-active => remove from orderbook + remove from matching engine
     */

    return Promise.resolve();
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

    /**
     * if we failed to find a cursor, load the most recent snapshot
     */
    if (!syncCursor) {
      ({ syncCursor } = await this._loadSnapshot(signal));
      await this._db.set(syncCursorKey, JSON.stringify(syncCursor));
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
      await this._db.set(syncCursorKey, JSON.stringify(syncCursor));

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
    await this._maintainSync(signal, syncCursor);
  }

  protected _maintainSync(signal: RedlockAbortSignal, syncCursor: OrderStatusEventSyncCursor) {
    const orderStatusEvents = this._firestore.collectionGroup(
      'orderStatusChanges'
    ) as FirebaseFirestore.CollectionGroup<OrderStatusEvent>;

    const orderStatusEventsQuery = orderStatusEvents
      .where('chainId', '==', config.env.chainId)
      .where('isMostRecent', '==', true)
      .orderBy('timestamp', 'asc')
      .orderBy('id', 'asc')
      .startAfter(syncCursor.timestamp, syncCursor.eventId);

    type Acc = {
      added: FirebaseFirestore.DocumentChange<OrderStatusEvent>[];
      removed: FirebaseFirestore.DocumentChange<OrderStatusEvent>[];
      modified: FirebaseFirestore.DocumentChange<OrderStatusEvent>[];
    };

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
              order: data.order,
              status: data.status
            };
          });

          await this.add(jobData);
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
      await this.add({ id: data.orderId, order: data.order, status: data.status });

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
      await this.add({ id: item.id, order: item.order, status: 'active' });
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

  protected async *_getSnapshot(source: {
    bucket: string;
    file: string;
  }): AsyncGenerator<{ id: string; order: ChainOBOrder }> {
    const cloudStorageFile = this._storage.bucket(source.bucket).file(source.file);
    const snapshotReadStream = cloudStorageFile.createReadStream();

    const rl = ReadLine.createInterface({
      input: snapshotReadStream,
      crlfDelay: Infinity
    });

    for await (const line of rl) {
      try {
        const order = JSON.parse(line) as { id: string; order: ChainOBOrder };
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
