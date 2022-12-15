import { Redis } from 'ioredis';

import { OrderbookV1 } from '@/lib/orderbook';

export class MatchingEngine {
  public readonly version = 'v1';

  constructor(protected _orderbook: OrderbookV1.Orderbook, protected _db: Redis) {}
}
