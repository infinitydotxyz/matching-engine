import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { startExecutionEngine } from 'start-execution-engine';

import { logger } from '@/common/logger';

const base = '/execution';

export default async function register(fastify: FastifyInstance, options: FastifyPluginOptions) {
  fastify.put(`${base}`, () => {
    startExecutionEngine().catch((err) => {
      logger.error(`PUT ${base}`, `Failed to start execution engine ${JSON.stringify(err)}`);
    });

    return { status: 'ok' };
  });

  await Promise.resolve();
}
