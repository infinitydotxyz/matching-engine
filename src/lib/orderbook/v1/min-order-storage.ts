import { Redis } from 'ioredis';

import { ChainId } from '@infinityxyz/lib/types/core';

import { OrderStorage } from './order-storage.abstract';
import { Status } from './types';

export interface MinOrder {
  id: string;
  chainId: string;
  status: Status;
  side: 'buy' | 'sell';
}

/**
 * Provides access to an orders min data storage
 *
 * Stores MinOrder objects as JSON strings in a Redis hash
 */
export class MinOrderStorage extends OrderStorage {
  public readonly storageKey = 'min-order';

  protected get key() {
    return `${this._baseKey()}:${this.storageKey}`;
  }

  constructor(_db: Redis, _chainId: ChainId, version: string) {
    super(_db, _chainId, version);
  }

  async has(orderId: string): Promise<boolean> {
    const result = await this._db.hexists(this.key, orderId);
    return result === 1;
  }

  async get(orderId: string): Promise<MinOrder | null> {
    const result = await this._db.hget(this.key, orderId);
    if (!result) {
      return null;
    }
    try {
      return JSON.parse(result) as MinOrder;
    } catch (err) {
      return null;
    }
  }

  async set(order: MinOrder): Promise<void> {
    await this._db.hset(this.key, order.id, JSON.stringify(order));
  }

  async delete(orderId: string): Promise<void> {
    await this._db.hdel(this.key, orderId);
  }

  async setStatus(orderId: string, status: Status): Promise<void> {
    await this._db.watch(this.key);
    const order = await this.get(orderId);
    if (!order) {
      throw new Error(`Order ${orderId} not found`);
    }
    const updatedOrder = {
      ...order,
      status
    };
    await this._db.multi().hset(this.key, orderId, JSON.stringify(updatedOrder)).exec();
  }

  async size(): Promise<number> {
    return await this._db.hlen(this.key);
  }
}
