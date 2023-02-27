import { FastifyInstance } from 'fastify';

import { logger } from '@/common/logger';
import { config } from '@/config';

import { getExecutionEngine, startExecutionEngine } from '../../../start-execution-engine';

const base = '/execution';

export default async function register(fastify: FastifyInstance) {
  if (!config.components.api.readonly) {
    fastify.put(`${base}`, () => {
      startExecutionEngine().catch((err) => {
        logger.error(`PUT ${base}`, `Failed to start execution engine ${JSON.stringify(err)}`);
      });

      return { status: 'ok' };
    });
  }

  fastify.get(`${base}`, async () => {
    const { executionEngine, nonceProvider } = await getExecutionEngine();

    const jobsProcessing = await executionEngine.queue.count();
    const jobCounts = await executionEngine.queue.getJobCounts();
    const healthCheck = await executionEngine.checkHealth();

    nonceProvider.close();
    await executionEngine.close();

    return {
      executionEngine: {
        healthStatus: healthCheck,
        jobsProcessing: jobsProcessing,
        jobCounts
      }
    };
  });

  await Promise.resolve();
}
