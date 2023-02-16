import { ethers } from 'ethers';
import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { startCollection } from 'start-collection';

import { logger } from '@/common/logger';

const base = '/collection';

// eslint-disable-next-line @typescript-eslint/require-await
export default async function register(fastify: FastifyInstance, options: FastifyPluginOptions) {
  fastify.get(`${base}`, async (request, reply) => {
    return { hello: 'world' };
  });

  fastify.put(`${base}/:collection`, async (request, reply) => {
    const collection =
      typeof request.params == 'object' &&
      request.params &&
      'collection' in request.params &&
      typeof request.params.collection === 'string'
        ? request.params.collection
        : '';
    if (!ethers.utils.isAddress(collection)) {
      throw new Error('Invalid collection address');
    }

    startCollection(collection).catch((err) => {
      logger.error(`PUT ${base}/:collection`, `Failed to start collection ${collection} ${JSON.stringify(err)}`);
    });

    return { status: 'ok' };
  });
}
