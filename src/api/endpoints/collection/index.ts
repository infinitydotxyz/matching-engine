import { ethers } from 'ethers';
import { FastifyInstance, FastifyPluginOptions } from 'fastify';

import { getOBComplicationAddress } from '@infinityxyz/lib/utils';

import { firestore, redis, redlock, storage } from '@/common/db';
import { logger } from '@/common/logger';
import { config } from '@/config';
import { MatchingEngine } from '@/lib/matching-engine/v1';
import { OrderRelay } from '@/lib/order-relay/v1/order-relay';
import { OrderbookV1 } from '@/lib/orderbook';

const base = '/collection';

const getProcesses = (collection: string) => {
  const orderbookStorage = new OrderbookV1.OrderbookStorage(redis, config.env.chainId);
  const complication = getOBComplicationAddress(config.env.chainId);
  const orderbook = new OrderbookV1.Orderbook(orderbookStorage, new Set([complication]));

  const matchingEngine = new MatchingEngine(redis, config.env.chainId, orderbookStorage, redlock, collection, {
    debug: config.env.debug,
    concurrency: 1,
    enableMetrics: false
  });

  const orderRelay = new OrderRelay(matchingEngine, firestore, storage, redlock, orderbook, redis, collection, {
    debug: config.env.debug,
    concurrency: 1,
    enableMetrics: false
  });

  return { orderRelay, matchingEngine, orderbookStorage };
};

const startCollection = async (collection: string) => {
  /**
   * start a relayer and matching engine for the collection
   */
  const { matchingEngine, orderRelay } = getProcesses(collection);
  try {
    const matchingEnginePromise = matchingEngine.run();
    const orderRelayPromise = orderRelay.run();
    await Promise.all([matchingEnginePromise, orderRelayPromise]);
  } catch (err) {
    logger.error(`PUT ${base}/:collection`, `Failed to start collection ${collection} ${JSON.stringify(err)}`);
    await matchingEngine.close().catch((err) => {
      logger.error(`PUT ${base}/:collection`, `Failed to close matching engine ${JSON.stringify(err)}`);
    });
    await orderRelay.close().catch((err) => {
      logger.error(`PUT ${base}/:collection`, `Failed to close order relay ${JSON.stringify(err)}`);
    });
    logger.log('PUT ${base}/:collection', `Closed failed processes for ${collection}`);
  }
};

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
