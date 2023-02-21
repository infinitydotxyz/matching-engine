import { Job } from 'bullmq';
import Redis from 'ioredis';

import { ChainId } from '@infinityxyz/lib/types/core';

import { AbstractProcess } from '../process/process.abstract';
import { ProcessOptions } from '../process/types';

export abstract class AbstractMatchingEngine<T extends { id: string }, U> extends AbstractProcess<T, U> {
  constructor(
    protected _chainId: ChainId,
    protected _db: Redis,
    protected queueName: string,
    options?: ProcessOptions
  ) {
    super(_db, queueName, options);
  }

  abstract processJob(job: Job<T, U>): Promise<U>;
}
