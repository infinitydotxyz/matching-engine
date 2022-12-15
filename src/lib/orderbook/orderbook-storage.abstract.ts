/**
 * Orderbook storage is responsible for
 * storing and retrieving orders
 */
export abstract class AbstractOrderbookStorage<T, U> {
  abstract getOrderId(order: T): string;

  abstract has(orderId: string): Promise<boolean>;
  abstract get(orderId: string): Promise<T | null>;
  abstract save(order: { order: T; status: U } | { order: T; status: U }[]): Promise<void>;

  abstract getStatus(orderId: string): Promise<U | null>;
  abstract setStatus(orderId: string, status: U): Promise<void>;

  abstract getSize(): Promise<number>;
  abstract getSizeByStatus(status: U): Promise<number>;
}
