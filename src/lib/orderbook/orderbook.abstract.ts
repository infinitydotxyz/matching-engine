import { ErrorCode, OrderbookOrderError } from './errors';
import { AbstractOrderbookStorage } from './orderbook-storage.abstract';

/**
 * An orderbook is responsible for
 * 1. receiving orders from clients
 *  * Ensuring the order is compatible
 *  * Saving the order
 *
 * 2. receiving order status updates from clients
 *  * Updating the status of the order
 */
export type OrderValidationResponse = { isValid: true } | { isValid: false; error: OrderbookOrderError };

export abstract class AbstractOrderbook<T, U> {
  constructor(protected _storage: AbstractOrderbookStorage<T, U>) {}

  abstract isOrderValid(order: T): Promise<OrderValidationResponse> | OrderValidationResponse;

  async checkOrder(order: T): Promise<void> {
    const { isValid } = await this.isOrderValid(order);
    if (!isValid) {
      const orderId = this._storage.getOrderId(order);
      throw new OrderbookOrderError(orderId, ErrorCode.InvalidOrder, 'Invalid order');
    }
  }

  async add(items: { order: T; status: U } | { order: T; status: U }[]): Promise<void> {
    if (Array.isArray(items)) {
      for (const { order } of items) {
        await this.checkOrder(order);
      }
    } else {
      await this.checkOrder(items.order);
    }

    await this._storage.save(items);
  }

  async setStatus(orderId: string, status: U): Promise<void> {
    const orderExists = await this._storage.has(orderId);
    if (!orderExists) {
      throw new OrderbookOrderError(orderId, ErrorCode.OrderDoesNotExist, `Order ${orderId} does not exist`);
    }

    await this._storage.setStatus(orderId, status);
  }
}
