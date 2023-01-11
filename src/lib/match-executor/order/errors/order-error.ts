import { OrderSource } from '@infinityxyz/lib/types/core';

import { ErrorCode } from './error-code';

export class OrderError extends Error {
  constructor(
    reason: string,
    public readonly errorCode: ErrorCode,
    public readonly value: string,
    public readonly source: OrderSource | 'unknown',
    public readonly type: 'unsupported' | 'unexpected' = 'unsupported'
  ) {
    super(`${type} order: ${reason}`);
  }

  public toJSON() {
    return {
      errorCode: this.errorCode,
      value: this.value,
      source: this.source,
      reason: this.message,
      type: this.type
    };
  }
}

export class OrderSideError extends OrderError {
  constructor(isSellOrder: boolean, source: OrderSource, type: 'unsupported' | 'unexpected' = 'unsupported') {
    super(`order side`, ErrorCode.OrderSide, isSellOrder ? 'sell' : 'buy', source, type);
  }
}

export class OrderKindError extends OrderError {
  constructor(kind: string, source: OrderSource, type: 'unsupported' | 'unexpected' = 'unsupported') {
    super(`order kind`, ErrorCode.OrderKind, kind, source, type);
  }
}

export class OrderSourceError extends OrderError {
  constructor(source: string, type: 'unsupported' | 'unexpected' = 'unsupported') {
    super(`order source`, ErrorCode.OrderSource, source, source as 'unknown', type);
  }
}

export class OrderDynamicError extends OrderError {
  constructor(source: OrderSource) {
    super(`dynamic order`, ErrorCode.DynamicOrder, 'true', source, 'unsupported');
  }
}

export class OrderCurrencyError extends OrderError {
  constructor(source: OrderSource, currency: string) {
    super(`order currency`, ErrorCode.OrderCurrency, currency, source, 'unsupported');
  }
}

export class NotFoundError extends OrderError {
  constructor(message: string) {
    super(`not found`, ErrorCode.NotFound, message, 'unknown', 'unexpected');
  }
}

export class UnexpectedOrderError extends OrderError {
  constructor(message: string) {
    super(`error`, ErrorCode.Unexpected, message, 'unknown', 'unexpected');
  }
}
