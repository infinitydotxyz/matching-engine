import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { getExecutionEngine, startExecutionEngine } from 'start-execution-engine';

import { logger } from '@/common/logger';

const base = '/execution';

export default async function register(fastify: FastifyInstance, options: FastifyPluginOptions) {
  fastify.put(`${base}`, () => {
    startExecutionEngine().catch((err) => {
      logger.error(`PUT ${base}`, `Failed to start execution engine ${JSON.stringify(err)}`);
    });

    return { status: 'ok' };
  });

  fastify.get(`${base}`, async () => {
    const { executionEngine } = await getExecutionEngine();

    const jobsProcessing = await executionEngine.queue.count();
    const jobCounts = await executionEngine.queue.getJobCounts();
    const healthCheck = await executionEngine.checkHealth();

    await executionEngine.close();

    return {
      isSynced: jobCounts.waiting < 100,
      matchingEngine: {
        healthStatus: healthCheck,
        jobsProcessing: jobsProcessing,
        jobCounts
      }
    };
  });

  await Promise.resolve();
}
