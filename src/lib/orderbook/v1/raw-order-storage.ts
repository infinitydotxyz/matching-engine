import { Order } from './order';
import { OrderStorage } from './order-storage.abstract';

/**
 * Raw order storage stores a large order object
 * including the signed order
 *
 * Stores OrderParam objects using Redis JSON
 */
export class RawOrderStorage extends OrderStorage {
  public readonly storageKey = 'raw-order';

  protected get key() {
    return `${this._baseKey()}:${this.storageKey}`;
  }

  protected _getOrderKey(orderId: string) {
    return `${this.key}:${orderId}`;
  }

  async get(orderId: string): Promise<Order | null> {
    const stringResult = (await this._db.call('JSON.GET', this._getOrderKey(orderId), '$')) as string;
    try {
      return Order.fromString(stringResult);
    } catch (err) {
      return null;
    }
  }

  async set(order: Order): Promise<void> {
    await this._db.call('JSON.SET', this._getOrderKey(order.id), '$', order.toString());
  }

  async delete(orderId: string): Promise<void> {
    await this._db.call('JSON.DEL', this._getOrderKey(orderId), '$');
  }
}
