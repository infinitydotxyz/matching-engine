import { getOBComplicationAddress } from '@infinityxyz/lib/utils';

import { firestore, redis, redlock, storage } from './common/db';
import { logger } from './common/logger';
import { config } from './config';
import { MatchingEngine } from './lib/matching-engine/v1';
import { OrderRelay } from './lib/order-relay/v1/order-relay';
import { OrderbookV1 } from './lib/orderbook';

export const getProcesses = (collection: string) => {
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

export const startCollection = async (_collection: string) => {
  const collection = _collection.trim().toLowerCase();
  /**
   * start a relayer and matching engine for the collection
   */
  const { matchingEngine, orderRelay } = getProcesses(collection);
  try {
    const matchingEnginePromise = matchingEngine.run();
    const orderRelayPromise = orderRelay.run();
    await Promise.all([matchingEnginePromise, orderRelayPromise]);
  } catch (err) {
    logger.error(`start-collection`, `Failed to start collection ${collection} ${JSON.stringify(err)}`);
    await matchingEngine.close().catch((err) => {
      logger.error(`start-collection`, `Failed to close matching engine ${JSON.stringify(err)}`);
    });
    await orderRelay.close().catch((err) => {
      logger.error(`start-collection`, `Failed to close order relay ${JSON.stringify(err)}`);
    });
    logger.log('start-collection', `Closed failed processes for ${collection}`);
  }
};
