import { logger } from '@/common/logger';

import { ErrorCode, OrderbookOrderError } from '../errors';
import { AbstractOrderbook, OrderValidationResponse } from '../orderbook.abstract';
import { Order } from './order';
import { OrderData } from './types';

export class Orderbook extends AbstractOrderbook<Order, OrderData> {
  isOrderValid(order: Order): OrderValidationResponse {
    const orderComplication = order.params.complication;
    if (!this._supportedComplications.has(orderComplication)) {
      return {
        isValid: false,
        error: new OrderbookOrderError(
          order.id,
          ErrorCode.InvalidComplication,
          `Invalid Complication. ${orderComplication}`
        )
      };
    }
    try {
      order.validate();
      return { isValid: true };
    } catch (err) {
      if (err instanceof OrderbookOrderError) {
        return { isValid: false, error: err };
      }
      if (err instanceof Error) {
        logger.error('orderbook', err.message);
      } else {
        logger.error('orderbook', `${err}`);
      }
      return { isValid: false, error: new OrderbookOrderError(order.id, ErrorCode.InvalidOrder, `Unknown error`) };
    }
  }
}
