import { FastifyInstance } from 'fastify';

import { logger } from '@/common/logger';
import { config } from '@/config';

import { getExecutionEngine, initExecutionEngine } from '../../../init-execution-engine';

const base = '/execution';

export default async function register(fastify: FastifyInstance) {
  if (!config.components.api.readonly) {
    fastify.put(`${base}`, () => {
      initExecutionEngine().catch((err) => {
        logger.error(`PUT ${base}`, `Failed to start execution engine ${JSON.stringify(err)}`);
      });

      return { status: 'ok' };
    });
  }

  fastify.get(`${base}`, async () => {
    const { executionEngine } = await getExecutionEngine();
    const healthInfo = await executionEngine.getHealthInfo();

    await executionEngine.close();

    return {
      executionEngine: healthInfo
    };
  });

  await Promise.resolve();
}
