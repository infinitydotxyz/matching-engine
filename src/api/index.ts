import Fastify, { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { startExecutionEngine } from 'scripts/start-execution-engine';
import { startMatchingEngine } from 'scripts/start-matching-engine';

import cors from '@fastify/cors';
import { sleep } from '@infinityxyz/lib/utils';

import { config } from '@/config';

import blocks from './endpoints/blocks';
import executionEngine from './endpoints/execution';
import matchingEngine from './endpoints/matching';
import orders from './endpoints/orders';

Error.stackTraceLimit = Infinity;

const fastify = Fastify({
  jsonShorthand: false,
  ignoreTrailingSlash: true,
  ignoreDuplicateSlashes: true,
  logger: true,
  trustProxy: true
});

const auth = (instance: FastifyInstance, _opts: FastifyPluginOptions, next: () => void) => {
  instance.addHook('onRequest', async (request, reply) => {
    const { headers } = request;
    const apiKey = headers['x-api-key'];
    if (typeof apiKey === 'string') {
      if (apiKey.toLowerCase() === config.components.api.apiKey) {
        return;
      }
    }
    await reply.code(401).send({ error: 'Unauthorized' });
  });
  next();
};

const register = async () => {
  await fastify.register(cors, {});

  if (config.components.executionEngine.enabled) {
    await fastify.register(auth, executionEngine);
  }
  if (config.components.matchingEngine.enabled) {
    await fastify.register(auth, matchingEngine);
  }
  await fastify.register(auth, orders);
  await fastify.register(auth, blocks);
};

const start = async () => {
  await register();
  try {
    await fastify.listen({ port: config.components.api.port, host: '0.0.0.0' });

    if (!config.components.api.readonly && config.env.isDeployed) {
      if (config.components.executionEngine.enabled) {
        await sleep(5000);
        await startExecutionEngine(config.env.version);
      }
      if (config.components.matchingEngine.enabled) {
        await sleep(5000);
        await startMatchingEngine(config.env.version);
      }
    }
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

void start();
