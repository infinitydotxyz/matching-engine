import Redis, { ChainableCommander } from 'ioredis';

import { ChainId, ExecutionStatusMatchedExecuted } from '@infinityxyz/lib/types/core';

import { ExecutionBlock } from '@/common/block';
import { ExecutionOrder } from '@/common/execution-order';
import { BatchHandler } from '@/lib/firestore/batch-handler';

import { OrderbookStorage } from './orderbook-storage';

export class ExecutionStorage {
  public readonly version = 'v1';
  /**
   * ------ ORDER EXECUTION STATUS ------
   */

  /**
   * key value pair of an order to a pending execution status
   */
  getPendingOrderExecutionKey(orderId: string) {
    return `block-storage:${this.version}:chain:${this._chainId}:order-execution:pending:${orderId}`;
  }

  /**
   * key value pair of an order to a not-included execution status
   */
  getNotIncludedOrderExecutionKey(orderId: string) {
    return `block-storage:${this.version}:chain:${this._chainId}:order-execution:not-included:${orderId}`;
  }

  /**
   * key value pair of an order to an executed execution status
   */
  getExecutedOrderExecutionKey(orderId: string) {
    return `block-storage:${this.version}:chain:${this._chainId}:order-execution:executed:${orderId}`;
  }

  /**
   * key value pair of an order to an inexecutable execution status
   */
  getInexecutableOrderExecutionKey(orderId: string) {
    return `block-storage:${this.version}:chain:${this._chainId}:order-execution:inexecutable:${orderId}`;
  }

  /**
   * ------ MATCH STATS ------
   */

  getCollectionMatchDurationsKey(collection: string) {
    return `stats:${this.version}:chain:${this._chainId}:collection:${collection}:match-duration`;
  }

  getCollectionAverageMatchDurationKey(collection: string) {
    return `stats:${this.version}:chain:${this._chainId}:collection:${collection}:match-duration:average`;
  }

  getGlobalMatchDurationsKey() {
    return `stats:${this.version}:chain:${this._chainId}:global:match-duration`;
  }

  getGlobalAverageMatchDurationsKey() {
    return `stats:${this.version}:chain:${this._chainId}:global:match-duration:average`;
  }

  /**
   * ------ EXECUTION STATS ------
   */

  getCollectionExecutionDurationsKey(collection: string) {
    return `stats:${this.version}:chain:${this._chainId}:collection:${collection}:execution-duration`;
  }

  getCollectionAverageExecutionDurationsKey(collection: string) {
    return `stats:${this.version}:chain:${this._chainId}:collection:${collection}:execution-duration:average`;
  }

  getGlobalExecutionDurationsKey() {
    return `stats:${this.version}:chain:${this._chainId}:global:execution-duration`;
  }

  getGlobalAverageExecutionDurationsKey() {
    return `stats:${this.version}:chain:${this._chainId}:global:execution-duration:average`;
  }

  /**
   * ------ BLOCK EXECUTION STATUS ------
   */
  getBlockKey(blockNumber: number) {
    return `block-storage:${this.version}:chain:${this._chainId}:blockNumber:${blockNumber}`;
  }

  /**
   * A fixed-size list of the most recent block numbers
   */
  get mostRecentBlocksKey() {
    return `block-storage:${this.version}:chain:${this._chainId}:blocks:most-recent`;
  }

  get mostRecentBlocksSize() {
    return 16;
  }

  constructor(
    protected _db: Redis,
    protected _firestore: FirebaseFirestore.Firestore,
    protected _orderbookStorage: OrderbookStorage,
    protected _chainId: ChainId
  ) {}

  async getBlock(blockNumber: number) {
    const key = this.getBlockKey(blockNumber);
    const block = await this._db.get(key);
    try {
      return JSON.parse(block ?? '') as ExecutionBlock;
    } catch (e) {
      return null;
    }
  }

  async getOrderExecutionStatus(orderId: string): Promise<ExecutionOrder | null> {
    const pending = this.getPendingOrderExecutionKey(orderId);
    const notIncluded = this.getNotIncludedOrderExecutionKey(orderId);
    const executed = this.getExecutedOrderExecutionKey(orderId);
    const inexecutable = this.getInexecutableOrderExecutionKey(orderId);
    const [pendingStatusEncoded, notIncludedStatusEncoded, executedStatusEncoded, inexecutableStatusEncoded] =
      await this._db.mget(pending, notIncluded, executed, inexecutable);

    const [pendingStatus, notIncludedStatus, executedStatus, inexecutableStatus] = [
      pendingStatusEncoded,
      notIncludedStatusEncoded,
      executedStatusEncoded,
      inexecutableStatusEncoded
    ].map((status) => {
      try {
        return JSON.parse(status ?? '') as ExecutionOrder;
      } catch (e) {
        return null;
      }
    });

    if (executedStatus) {
      return executedStatus;
    } else {
      const mostRecentBlocksEncoded = await this._db.lrange(this.mostRecentBlocksKey, 0, 4);
      let mostRecentBlocks: ExecutionBlock[];
      try {
        mostRecentBlocks = mostRecentBlocksEncoded.map((item) => JSON.parse(item ?? '')) as ExecutionBlock[];
      } catch (err) {
        mostRecentBlocks = [];
      }
      /**
       * Find the most recent status
       */
      const mostRecent = [pendingStatus, notIncludedStatus, inexecutableStatus]
        .sort((a, b) => (a?.block?.number ?? 0) - (b?.block?.number ?? 0))
        .pop();

      /**
       * Check if the most recent status is recent enough
       */
      if (mostRecent?.block.number && mostRecentBlocks.find((block) => block.number < mostRecent.block.number)) {
        return mostRecent;
      }

      return null;
    }
  }

  /**
   * save any executed orders to the persistent db
   */
  async saveExecutedOrders(executedOrders: string[]) {
    const batchHandler = new BatchHandler();
    for (const orderId of executedOrders) {
      const executionStatus = await this._orderbookStorage.getExecutionStatus(orderId);
      if (executionStatus.status === 'matched-executed') {
        const ref = this._firestore
          .collection('executedOrders')
          .doc(orderId) as FirebaseFirestore.DocumentReference<ExecutionStatusMatchedExecuted>;

        await batchHandler.addAsync(ref, executionStatus, { merge: true });
      }
    }
    await batchHandler.flush();
  }

  async getAverageMatchDuration(collection: string) {
    const collectionMatchDurationListKey = this.getCollectionMatchDurationsKey(collection);
    const collectionAverageMatchDurationKey = this.getCollectionAverageMatchDurationKey(collection);
    const globalMatchDurationListKey = this.getGlobalMatchDurationsKey();
    const globalAverageMatchDurationKey = this.getGlobalAverageMatchDurationsKey();

    const [collectionAverageMatchDurationString, globalAverageMatchDurationString] = await this._db.mget(
      collectionAverageMatchDurationKey,
      globalAverageMatchDurationKey
    );

    let collectionAverageMatchDuration: number | null = collectionAverageMatchDurationString
      ? parseInt(collectionAverageMatchDurationString, 10)
      : null;

    let globalAverageMatchDuration: number | null = globalAverageMatchDurationString
      ? parseInt(globalAverageMatchDurationString, 10)
      : null;

    if (collectionAverageMatchDuration == null) {
      const collectionMatchDurations = await this._db.lrange(collectionMatchDurationListKey, 0, -1);
      if (collectionMatchDurations.length > 0) {
        collectionAverageMatchDuration =
          collectionMatchDurations.reduce((sum, item) => {
            return (sum += parseInt(item, 10));
          }, 0) / collectionMatchDurations.length;
        await this._db.set(collectionAverageMatchDurationKey, collectionAverageMatchDuration, 'PX', 30_000);
      }
    }
    if (globalAverageMatchDuration == null) {
      const globalMatchDurations = await this._db.lrange(globalMatchDurationListKey, 0, -1);
      if (globalMatchDurations.length > 0) {
        globalAverageMatchDuration =
          globalMatchDurations.reduce((sum, item) => {
            return (sum += parseInt(item, 10));
          }, 0) / globalMatchDurations.length;
        await this._db.set(globalAverageMatchDurationKey, globalAverageMatchDuration, 'PX', 30_000);
      }
    }

    return {
      globalAverage: globalAverageMatchDuration,
      collectionAverage: collectionAverageMatchDuration
    };
  }

  async getAverageExecutionDuration(collection: string) {
    const collectionExecutionDurationListKey = this.getCollectionExecutionDurationsKey(collection);
    const collectionAverageExecutionDurationKey = this.getCollectionAverageExecutionDurationsKey(collection);
    const globalExecutionDurationListKey = this.getGlobalExecutionDurationsKey();
    const globalAverageExecutionDurationKey = this.getGlobalAverageExecutionDurationsKey();

    const [collectionAverageExecutionDurationString, globalAverageExecutionDurationString] = await this._db.mget(
      collectionAverageExecutionDurationKey,
      globalAverageExecutionDurationKey
    );

    let collectionAverageExecutionDuration: number | null = collectionAverageExecutionDurationString
      ? parseInt(collectionAverageExecutionDurationString, 10)
      : null;

    let globalAverageExecutionDuration: number | null = globalAverageExecutionDurationString
      ? parseInt(globalAverageExecutionDurationString, 10)
      : null;

    if (collectionAverageExecutionDuration == null) {
      const collectionExecutionDurations = await this._db.lrange(collectionExecutionDurationListKey, 0, -1);
      if (collectionExecutionDurations.length > 0) {
        collectionAverageExecutionDuration =
          collectionExecutionDurations.reduce((sum, item) => {
            return sum + parseInt(item, 10);
          }, 0) / collectionExecutionDurations.length;
        await this._db.set(collectionAverageExecutionDurationKey, collectionAverageExecutionDuration, 'PX', 30_000);
      }
    }
    if (globalAverageExecutionDuration == null) {
      const globalExecutionDurations = await this._db.lrange(globalExecutionDurationListKey, 0, -1);
      if (globalExecutionDurations.length > 0) {
        globalAverageExecutionDuration =
          globalExecutionDurations.reduce((sum, item) => {
            return sum + parseInt(item, 10);
          }, 0) / globalExecutionDurations.length;
        await this._db.set(globalAverageExecutionDurationKey, globalAverageExecutionDuration, 'PX', 30_000);
      }
    }

    return {
      globalAverage: globalAverageExecutionDuration,
      collectionAverage: collectionAverageExecutionDuration
    };
  }

  saveMatchDuration(pipeline: ChainableCommander, collection: string, duration: number) {
    const collectionMatchDurationKey = this.getCollectionMatchDurationsKey(collection);
    const globalMatchDurationKey = this.getGlobalMatchDurationsKey();

    pipeline.lpush(collectionMatchDurationKey, duration);
    pipeline.ltrim(collectionMatchDurationKey, 0, 999);
    pipeline.lpush(globalMatchDurationKey, duration);
    pipeline.ltrim(globalMatchDurationKey, 0, 999);
  }

  saveExecutionDuration(pipeline: ChainableCommander, collection: string, duration: number) {
    const collectionMatchExecutionKey = this.getCollectionExecutionDurationsKey(collection);
    const globalMatchExecutionKey = this.getGlobalExecutionDurationsKey();

    pipeline.lpush(collectionMatchExecutionKey, duration);
    pipeline.ltrim(collectionMatchExecutionKey, 0, 999);
    pipeline.lpush(globalMatchExecutionKey, duration);
    pipeline.ltrim(globalMatchExecutionKey, 0, 999);
  }

  async getMostRecentBlock() {
    const result = await this._db.lrange(this.mostRecentBlocksKey, 0, -1);
    return result.reduce((acc: ExecutionBlock | null, item) => {
      try {
        const block = JSON.parse(item) as ExecutionBlock;

        if (!acc) {
          return block;
        }

        if (block.number > acc.number) {
          return block;
        }
        return acc;
      } catch (err) {
        return acc;
      }
    }, null);
  }
}
