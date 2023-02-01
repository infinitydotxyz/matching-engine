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

export abstract class AbstractOrderbook<T, V> {
  constructor(protected _storage: AbstractOrderbookStorage<T, V>, protected _supportedComplications: Set<string>) {}

  abstract isOrderValid(order: T): Promise<OrderValidationResponse> | OrderValidationResponse;

  async checkOrder(order: T): Promise<void> {
    const result = await this.isOrderValid(order);
    if (!result.isValid) {
      const orderId = this._storage.getOrderId(order);
      throw new OrderbookOrderError(orderId, ErrorCode.InvalidOrder, result.error.message);
    }
  }

  async save(items: V | V[]): Promise<void> {
    await this._storage.save(items);
  }
}
