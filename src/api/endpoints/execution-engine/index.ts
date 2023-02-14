import { FastifyInstance, FastifyPluginOptions } from 'fastify';

const base = '/execution-engine';

// eslint-disable-next-line @typescript-eslint/require-await
export default async function register(fastify: FastifyInstance, options: FastifyPluginOptions) {
  fastify.get(`${base}`, async (request, reply) => {
    return { hello: 'world' };
  });
}
