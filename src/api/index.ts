import Fastify from 'fastify';

import { config } from '@/config';

import executionEngine from './endpoints/execution';
import matchingEngine from './endpoints/matching';

const fastify = Fastify({
  jsonShorthand: false,
  ignoreTrailingSlash: true,
  ignoreDuplicateSlashes: true,
  logger: true
});

const register = async () => {
  if (config.components.executionEngine.enabled) {
    await fastify.register(executionEngine);
  }
  if (config.components.matchingEngine.enabled) {
    await fastify.register(matchingEngine);
  }
};

const start = async () => {
  await register();
  try {
    await fastify.listen({ port: config.components.api.port });
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

void start();
