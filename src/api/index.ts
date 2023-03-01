import Fastify, { FastifyInstance, FastifyPluginOptions } from 'fastify';

import { config } from '@/config';

import executionEngine from './endpoints/execution';
import matchingEngine from './endpoints/matching';

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
  if (config.components.executionEngine.enabled) {
    await fastify.register(auth, executionEngine);
  }
  if (config.components.matchingEngine.enabled) {
    await fastify.register(auth, matchingEngine);
  }
};

const start = async () => {
  await register();
  try {
    await fastify.listen({ port: config.components.api.port, host: '0.0.0.0' });
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

void start();
