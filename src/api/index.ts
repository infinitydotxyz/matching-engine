import Fastify from 'fastify';

import { config } from '@/config';

import executionEngine from './endpoints/collection';

const fastify = Fastify({
  jsonShorthand: false,
  ignoreTrailingSlash: true,
  ignoreDuplicateSlashes: true,
  logger: true
});

const register = async () => {
  await fastify.register(executionEngine);
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
