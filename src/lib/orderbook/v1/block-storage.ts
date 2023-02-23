import Redis from 'ioredis';

import { ChainId } from '@infinityxyz/lib/types/core';

import { ExecutionBlock } from '@/common/block';

export class BlockStorage {
  public readonly version = 'v1';
  /**
   * ------ ORDER EXECUTION STATUS ------
   */

  /**
   * expiring key value pair of an order to a pending execution status
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
   * ------ BLOCK EXECUTION STATUS ------
   */

  getBlockKey(blockNumber: number) {
    return `block-storage:${this.version}:chain:${this._chainId}:blockNumber:${blockNumber}`;
  }

  constructor(protected _db: Redis, protected _chainId: ChainId) {}

  async getBlock(blockNumber: number) {
    const key = this.getBlockKey(blockNumber);
    const block = await this._db.get(key);
    try {
      return JSON.parse(block ?? '') as ExecutionBlock;
    } catch (e) {
      return null;
    }
  }
}
