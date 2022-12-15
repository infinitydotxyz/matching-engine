import Redis from 'ioredis';

import { ChainId } from '@infinityxyz/lib/types/core';

import { AbstractOrderbookStorage } from '../orderbook-storage.abstract';
import { MinOrderStorage } from './min-order-storage';
import { Order } from './order';
import { OrderItemStorage } from './order-item-storage';
import { OrderStatusStorage } from './order-status-storage';
import { RawOrderStorage } from './raw-order-storage';
import { Status } from './types';

/**
 * Responsible for storing orders and their statuses
 *
 */
export class OrderbookStorage extends AbstractOrderbookStorage<Order, Status> {
  public readonly version = 'v1';

  constructor(
    protected _db: Redis,
    protected _chainId: ChainId,
    protected _minOrderStorage: MinOrderStorage,
    protected _rawOrderStorage: RawOrderStorage,
    protected _orderStatusStorage: OrderStatusStorage,
    protected _orderItemStorage: OrderItemStorage
  ) {
    super();
  }

  getOrderId(order: Order): string {
    return order.id;
  }

  async get(orderId: string): Promise<Order | null> {
    return await this._rawOrderStorage.get(orderId);
  }

  async has(orderId: string): Promise<boolean> {
    return await this._minOrderStorage.has(orderId);
  }

  async save(items: { order: Order; status: Status } | { order: Order; status: Status }[]): Promise<void> {
    const arr = Array.isArray(items) ? items : [items];
    for (const { order, status } of arr) {
      await this._rawOrderStorage.set(order);
      await this._minOrderStorage.set({
        id: order.id,
        chainId: this._chainId,
        status,
        side: order.params.side
      });
      await this._orderStatusStorage.setOrderStatus(order.id, status);
      await this._orderItemStorage.set(order);
    } // TODO optimize with pipelining
  }

  async getStatus(orderId: string): Promise<Status | null> {
    const minOrder = await this._minOrderStorage.get(orderId);
    if (minOrder) {
      return minOrder.status;
    }

    return null;
  }

  async setStatus(orderId: string, status: Status): Promise<void> {
    await this._minOrderStorage.setStatus(orderId, status);
    await this._orderStatusStorage.setOrderStatus(orderId, status);
  }

  async getSize(): Promise<number> {
    return await this._minOrderStorage.size();
  }

  async getSizeByStatus(status: Status): Promise<number> {
    return await this._orderStatusStorage.getSizeByStatus(status);
  }
}
