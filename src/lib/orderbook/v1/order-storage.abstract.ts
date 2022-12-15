import { Redis } from 'ioredis';

import { ChainId } from '@infinityxyz/lib/types/core';

export abstract class OrderStorage {
  protected _baseKey() {
    return `orderbook:${this._version}:chain:${this._chainId}`;
  }

  abstract readonly storageKey: string;

  constructor(protected _db: Redis, protected _chainId: ChainId, protected _version: string) {}
}
