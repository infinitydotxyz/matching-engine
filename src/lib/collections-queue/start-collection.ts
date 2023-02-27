import { MetricsTime, Worker } from 'bullmq';

import { getOBComplicationAddress } from '@infinityxyz/lib/utils';

import { firestore, redis, redlock, storage } from '../../common/db';
import { logger } from '../../common/logger';
import { config } from '../../config';
import { MatchingEngine } from '../matching-engine/v1';
import { OrderRelay } from '../order-relay/v1/order-relay';
import { OrderbookV1 } from '../orderbook';
import { JobData, JobResult, getCollectionsQueue } from './start-collections-queue';

export const getOrderbook = () => {
  const orderbookStorage = new OrderbookV1.OrderbookStorage(redis, config.env.chainId);
  const complication = getOBComplicationAddress(config.env.chainId);
  const orderbook = new OrderbookV1.Orderbook(orderbookStorage, new Set([complication]));

  return { orderbook, orderbookStorage };
};

export const getProcesses = (collection: string) => {
  const { orderbook, orderbookStorage } = getOrderbook();

  const matchingEngine = new MatchingEngine(redis, config.env.chainId, orderbookStorage, redlock, collection, {
    debug: config.env.debug,
    concurrency: 1,
    enableMetrics: {
      maxDataPoints: MetricsTime.ONE_WEEK * 2
    }
  });

  const orderRelay = new OrderRelay(matchingEngine, firestore, storage, redlock, orderbook, redis, collection, {
    debug: config.env.debug,
    concurrency: 10,
    enableMetrics: {
      maxDataPoints: MetricsTime.ONE_WEEK * 2
    }
  });

  return { orderRelay, matchingEngine, orderbookStorage };
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
