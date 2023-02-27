import { MetricsTime, Queue, Worker } from 'bullmq';

import { redis } from '@/common/db';
import { logger } from '@/common/logger';
import { config } from '@/config';

export interface JobData {
  id: string;
  collection: string;
}
export type JobResult = void;

export const getCollectionsQueue = () => {
  const db = redis;
  const collectionsQueue = new Queue<JobData, JobResult>(`collections-queue:chain:${config.env.chainId}`, {
    connection: db.duplicate(),
    defaultJobOptions: {
      attempts: 5,
      backoff: {
        type: 'exponential',
        delay: 10_000
      },
      removeOnComplete: true,
      removeOnFail: 10_000,
      delay: 0
    }
  });

  return collectionsQueue;
};

export const startCollection = async (collection: string) => {
  const queue = getCollectionsQueue();

  const worker = new Worker<JobData, JobResult>(queue.name, `${__dirname}/worker.js`, {
    connection: redis.duplicate(),
    concurrency: 1,
    autorun: false,
    metrics: {
      maxDataPoints: MetricsTime.ONE_WEEK
    }
  });

  await queue.add(collection, {
    collection,
    id: collection
  });

  worker.on('error', (err) => {
    logger.error(`${collection}:runner`, err.message);
  });
  worker.on('active', (job) => {
    logger.log(`${collection}:runner`, `job ${job.id} - activated`);
  });
  worker.on('progress', (job) => {
    logger.log(`${collection}:runner`, `job ${job.id} - progress ${job.progress}`);
  });
  worker.on('completed', (job) => {
    logger.log(`${collection}:runner`, `job ${job.id} - completed`);
  });
  worker.on('failed', (job, err) => {
    logger.warn(`${collection}:runner`, `job ${job?.data.id} - failed ${err.message}`);
  });

  worker.on('stalled', (jobId) => {
    logger.log(`${collection}:runner`, `job: ${jobId} - stalled`);
  });

  worker.on('closing', () => {
    logger.log(`${collection}:runner`, `worker - closing`);
  });
  worker.on('closed', () => {
    logger.log(`${collection}:runner`, `worker - closed`);
  });

  worker.on('drained', () => {
    logger.log(`${collection}:runner`, `worker - drained`);
  });

  worker.on('ioredis:close', () => {
    logger.log(`${collection}:runner`, `ioredis - closed`);
  });

  worker.on('paused', () => {
    logger.log(`${collection}:runner`, `worker - paused`);
  });

  worker.on('ready', () => {
    logger.log(`${collection}:runner`, `worker - ready`);
  });

  worker.on('resumed', () => {
    logger.log(`${collection}:runner`, `worker - resumed`);
  });

  process.setMaxListeners(process.listenerCount('SIGINT') + 1);
  process.once('SIGINT', async () => {
    await worker.close();
    await queue.close();
  });

  await worker.run();
};
