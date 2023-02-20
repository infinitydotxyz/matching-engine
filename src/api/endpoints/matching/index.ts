import { ethers } from 'ethers';
import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { getProcesses, startCollection } from 'start-collection';

import { logger } from '@/common/logger';

const base = '/matching';

export default async function register(fastify: FastifyInstance, options: FastifyPluginOptions) {
  fastify.get(`${base}`, () => {
    return { hello: 'world' };
  });

  /**
   * get the status of the matching engine for a collection
   */
  fastify.get(`${base}/collection/:collection`, async (request) => {
    const _collection =
      typeof request.params == 'object' &&
      request.params &&
      'collection' in request.params &&
      typeof request.params.collection === 'string'
        ? request.params.collection
        : '';

    if (!ethers.utils.isAddress(_collection)) {
      throw new Error('Invalid collection address');
    }
    const collection = _collection.toLowerCase();

    const processes = getProcesses(collection);

    const matchingEngineJobsProcessing = await processes.matchingEngine.queue.count();
    const jobCounts = await processes.matchingEngine.queue.getJobCounts();

    const orderRelayJobsProcessing = await processes.orderRelay.queue.count();
    const orderRelayJobCounts = await processes.orderRelay.queue.getJobCounts();

    const matchingEngineHealthPromise = processes.matchingEngine.checkHealth();
    const orderRelayHealthPromise = processes.orderRelay.checkHealth();

    const [matchingEngineHealth, orderRelayHealth] = await Promise.all([
      matchingEngineHealthPromise,
      orderRelayHealthPromise
    ]);

    await processes.matchingEngine.close();
    await processes.orderRelay.close();

    return {
      isSynced: orderRelayJobCounts.waiting < 500,
      matchingEngine: {
        healthStatus: matchingEngineHealth,
        jobsProcessing: matchingEngineJobsProcessing,
        jobCounts
      },
      orderRelay: {
        healthStatus: orderRelayHealth,
        jobsProcessing: orderRelayJobsProcessing,
        jobCounts: orderRelayJobCounts
      }
    };
  });

  /**
   * start the matching engine for a collection
   */
  fastify.put(`${base}/collection/:collection`, (request) => {
    const _collection =
      typeof request.params == 'object' &&
      request.params &&
      'collection' in request.params &&
      typeof request.params.collection === 'string'
        ? request.params.collection
        : '';

    if (!ethers.utils.isAddress(_collection)) {
      throw new Error('Invalid collection address');
    }
    const collection = _collection.toLowerCase();

    startCollection(collection).catch((err) => {
      logger.error(`PUT ${base}/:collection`, `Failed to start collection ${collection} ${JSON.stringify(err)}`);
    });

    return { status: 'ok' };
  });

  await Promise.resolve();
}
