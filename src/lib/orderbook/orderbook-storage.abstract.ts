/**
 * Orderbook storage is responsible for
 * storing and retrieving orders
 */
export abstract class AbstractOrderbookStorage<T, U> {
  abstract getOrderId(order: T): string;

  abstract has(orderId: string): Promise<boolean>;
  abstract save(order: U | U[]): Promise<void>;
}
