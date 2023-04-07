import { FastifyInstance } from 'fastify';

import { getOrderbook } from '@/lib/collections-queue/start-collection';

const base = '/blocks';

export default async function register(fastify: FastifyInstance) {
  fastify.get(`${base}`, async (request) => {
    const { orderbookStorage } = getOrderbook();

    const blocks = await orderbookStorage.executionStorage.getBlocks();

    return {
      blocks
    };
  });

  await Promise.resolve();
}
