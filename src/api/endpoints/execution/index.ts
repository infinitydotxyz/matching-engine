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

    const healthInfo = await executionEngine.getHealthInfo();

    nonceProvider.close();
    await executionEngine.close();

    return {
      executionEngine: healthInfo
    };
  });

  await Promise.resolve();
}
