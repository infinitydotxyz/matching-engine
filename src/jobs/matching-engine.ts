import { Queue, Worker } from 'bullmq';

import { ChainId, ChainOBOrder } from '@infinityxyz/lib/types/core';

import { redis } from '@/common/db';

const QUEUE_NAME = 'matching-engine';

const queue = new Queue(QUEUE_NAME, {
  connection: redis.duplicate(),
  defaultJobOptions: {
    attempts: 5,
    backoff: {
      type: 'exponential',
      delay: 10_000
    },
    removeOnComplete: true,
    removeOnFail: 10_000
  }
});

export type MatchOrderJob = {
  id: string;
  chainId: ChainId;
  signedOrder: ChainOBOrder;
};
