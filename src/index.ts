import { getOBComplicationAddress } from '@infinityxyz/lib/utils';

import { config, getNetworkConfig } from '@/config';

import { firestore, redis, redlock, storage } from './common/db';
import { logger } from './common/logger';
import { ExecutionEngine } from './lib/execution-engine/v1';
import { MatchExecutor } from './lib/match-executor/match-executor';
import { NonceProvider } from './lib/match-executor/nonce-provider/nonce-provider';
import { MatchingEngine } from './lib/matching-engine/v1';
import { OrderRelay } from './lib/order-relay/v1/order-relay';
import { OrderbookV1 } from './lib/orderbook';

async function main() {
  const network = await getNetworkConfig(config.env.chainId);

  logger.info(
    'process',
    `Starting server with config: ${config.env.mode} Using forked network: ${network.isForkingEnabled}`
  );

  const collection = '0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d';

  const orderbookStorage = new OrderbookV1.OrderbookStorage(redis, config.env.chainId);
  const complication = getOBComplicationAddress(config.env.chainId);
  const orderbook = new OrderbookV1.Orderbook(orderbookStorage, new Set([complication]));

  const nonceProvider = new NonceProvider(
    config.env.chainId,
    network.initiator.address,
    network.exchangeAddress,
    redlock,
    network.httpProvider,
    firestore
  );

  const matchExecutor = new MatchExecutor(
    config.env.chainId,
    network.matchExecutorAddress,
    network.initiator,
    nonceProvider
  );

  const executionEngine = new ExecutionEngine<unknown>(
    config.env.chainId,
    orderbookStorage,
    redis,
    redlock,
    network.websocketProvider,
    network.httpProvider,
    matchExecutor,
    config.broadcasting.blockOffset,
    network.broadcaster,
    {
      debug: config.env.debug,
      concurrency: network.isForkingEnabled ? 1 : 20, // ideally this is set high enough that we never max it out
      enableMetrics: false
    }
  );

  const matchingEngine = new MatchingEngine(redis, config.env.chainId, orderbookStorage, {
    debug: config.env.debug,
    concurrency: 1,
    enableMetrics: false
  });

  const orderRelay = new OrderRelay(matchingEngine, firestore, storage, redlock, orderbook, redis, collection, {
    debug: config.env.debug,
    concurrency: 1,
    enableMetrics: false
  });

  const promises = [];
  if (config.components.orderRelay.enabled) {
    logger.info('process', 'Starting order relay');
    const orderRelayPromise = orderRelay.run(config.components.orderRelay.enableSyncing);
    promises.push(orderRelayPromise);
  }

  if (config.components.matchingEngine.enabled) {
    logger.info('process', 'Starting matching engine');
    const matchingEnginePromise = matchingEngine.run();
    promises.push(matchingEnginePromise);
  }

  if (config.components.executionEngine.enabled) {
    logger.info('process', 'Starting execution engine');
    const nonceProviderPromise = nonceProvider.run();
    const executionEnginePromise = executionEngine.run();
    promises.push(nonceProviderPromise, executionEnginePromise);
  }

  await Promise.all(promises);
}

void main();
