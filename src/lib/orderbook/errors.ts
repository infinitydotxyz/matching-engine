export enum ErrorCode {
  InvalidOrder = 1,
  IncompatibleOrder = 2,
  InvalidStatus = 3,
  OrderDoesNotExist = 4,
  InvalidComplication = 5
}

export class OrderbookError extends Error {
  constructor(public readonly errorCode: ErrorCode, message: string) {
    super(message);
  }

  toJSON() {
    return {
      type: 'ORDERBOOK_ERROR',
      errorCode: this.errorCode,
      message: this.message
    };
  }
}

export class OrderbookOrderError extends OrderbookError {
  constructor(public readonly orderId: string, errorCode: ErrorCode, message: string) {
    super(errorCode, message);
  }

  toJSON() {
    return {
      type: 'ORDERBOOK_ORDER_ERROR',
      orderId: this.orderId,
      message: this.message,
      errorCode: this.errorCode
    };
  }
}
