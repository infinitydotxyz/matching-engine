import { OrderSource } from '@infinityxyz/lib/types/core';

import { Match } from './types';

export abstract class OrderMatch<T> {
  constructor(protected _match: Match) {}

  abstract getExecInfo(): T;
}
