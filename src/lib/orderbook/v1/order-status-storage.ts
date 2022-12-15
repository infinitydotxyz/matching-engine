import { OrderStorage } from './order-storage.abstract';
import { Status } from './types';

export class OrderStatusStorage extends OrderStorage {
  storageKey = 'order-status';

  protected _getKey(status: Status) {
    return `${this._baseKey()}:${this.storageKey}:${status}`;
  }

  protected get statuses(): Status[] {
    return ['active', 'inactive', 'filled', 'cancelled', 'expired'];
  }

  async setOrderStatus(orderId: string, status: Status): Promise<void> {
    const key = this._getKey(status);

    const toRemove = this.statuses.filter((item) => item !== status).map((item) => this._getKey(item));

    let command = this._db.multi().sadd(key, orderId);

    for (const item of toRemove) {
      command = command.srem(item, orderId);
    }

    await command.exec();
  }

  async getSizeByStatus(status: Status): Promise<number> {
    return await this._db.scard(this._getKey(status));
  }

  getStatusSetId(status: Status): string {
    return this._getKey(status);
  }
}
