import { Job } from 'bullmq';

import { logger } from '@/common/logger';
import { getProcesses } from '@/lib/collections-queue/start-collection';

import { JobData } from './start-collections-queue';

export default async function (job: Job<JobData>) {
  const collection = job.data.collection.trim().toLowerCase();
  /**
   * start a relayer and matching engine for the collection
   */
  const { matchingEngine, orderRelay } = getProcesses(collection);
  try {
    const matchingEnginePromise = matchingEngine.run();
    const orderRelayPromise = orderRelay.run();
    await Promise.all([matchingEnginePromise, orderRelayPromise]);
  } catch (err) {
    logger.error(`start-collection`, `Failed to start collection ${collection} ${JSON.stringify(err)}`);
    await matchingEngine.close();
    await orderRelay.close();
    logger.log('start-collection', `Closed failed processes for ${collection}`);
  }
}
