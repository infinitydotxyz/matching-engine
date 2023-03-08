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

  getGlobalMatchDurationsKey() {
    return `stats:${this.version}:chain:${this._chainId}:global:match-duration`;
  }

  /**
   * ------ EXECUTION STATS ------
   */

  getCollectionExecutionDurationsKey(collection: string) {
    return `stats:${this.version}:chain:${this._chainId}:collection:${collection}:execution-duration`;
  }

  getGlobalExecutionDurationsKey() {
    return `stats:${this.version}:chain:${this._chainId}:global:execution-duration`;
  }

  /**
   * ------ BLOCK EXECUTION STATUS ------
   */
  getBlockKey(blockNumber: number) {
    return `block-storage:${this.version}:chain:${this._chainId}:blockNumber:${blockNumber}`;
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
      const mostRecent = [pendingStatus, notIncludedStatus, inexecutableStatus]
        .sort((a, b) => (a?.block?.number ?? 0) - (b?.block?.number ?? 0))
        .pop();

      return mostRecent ?? null;
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
}
