import { ErrorCode } from '../errors/error-code';
import { OrderError } from '../errors/order-error';
import { Order } from './order.abstract';

export class EndUserOrder extends Order {
  readonly isMatchExecutorOrder = false;

  getChainOrder() {
    return this._params;
  }

  _checkOrderKindValid() {
    if (this._orderData.source !== 'flow' || !this._params.sig) {
      throw new OrderError(
        'Invalid end user order',
        ErrorCode.Unexpected,
        `Source is ${this._orderData.source}. Is Signed ${!!this._params.sig}`,
        this.source,
        'unexpected'
      );
    }
  }
}
