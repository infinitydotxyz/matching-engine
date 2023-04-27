import Fastify, { FastifyInstance, FastifyPluginOptions } from 'fastify';

import cors from '@fastify/cors';
import { sleep } from '@infinityxyz/lib/utils';

import { getComponentLogger } from '@/common/logger';
import { config } from '@/config';
import { startExecutionEngine } from '@/scripts/start-execution-engine';
import { startMatchingEngine } from '@/scripts/start-matching-engine';

import blocks from './endpoints/blocks';
import executionEngine from './endpoints/execution';
import matchingEngine from './endpoints/matching';
import orders from './endpoints/orders';

Error.stackTraceLimit = Infinity;

const logger = getComponentLogger('api');

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
    if (!config.components.api.readonly && config.env.isDeployed) {
      if (config.components.executionEngine.enabled) {
        new Promise<void>((resolve, reject) => {
          logger.log(`Starting execution engine...`);
          sleep(5000)
            .then(() => {
              return startExecutionEngine(config.env.version);
            })
            .then(() => {
              resolve();
            })
            .catch((err) => {
              reject(err);
            });
        }).catch((err) => {
          logger.error(`${err}`);
        });
      }
      if (config.components.matchingEngine.enabled) {
        new Promise<void>((resolve, reject) => {
          logger.log(`Starting matching engine...`);
          sleep(5000)
            .then(() => {
              return startMatchingEngine(config.env.version);
            })
            .then(() => {
              resolve();
            })
            .catch((err) => {
              reject(err);
            });
        }).catch((err) => {
          logger.error(`${err}`);
        });
      }
      logger.log(`API listening on ${config.components.api.port}`);
      await fastify.listen({ port: config.components.api.port, host: '0.0.0.0' });
    } else {
      logger.log(`App is readonly or is not deployed, skipping auto-start`);
    }
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

void start();
