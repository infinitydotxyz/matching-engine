import { ErrorCode } from '../errors/error-code';
import { OrderError } from '../errors/order-error';
import { SeaportV15Order } from './order.abstract';

export class SingleTokenOrder extends SeaportV15Order {
  protected _checkOrderKindValid(): void {
    if (this.numItems !== 1) {
      throw new OrderError(
        "expected a single token order, but the order's numItems is not 1",
        ErrorCode.OrderTokenQuantity,
        `${this.numItems}`,
        this.source,
        'unexpected'
      );
    }
  }
}
