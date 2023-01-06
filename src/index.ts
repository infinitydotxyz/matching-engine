import { createMatch } from 'create-match';

import { config, getNetworkConfig } from '@/config';

import { firestore, redis, redlock, storage } from './common/db';
import { logger } from './common/logger';
import { ExecutionEngine } from './lib/execution-engine/v1';
import { MatchExecutor } from './lib/match-executor/match-executor';
import { MatchingEngine } from './lib/matching-engine/v1';
import { OrderRelay } from './lib/order-relay/v1/order-relay';
import { OrderbookV1 } from './lib/orderbook';

process.on('unhandledRejection', (error) => {
  logger.error('process', `Unhandled rejection: ${error}`);
});

async function main() {
  const network = await getNetworkConfig(config.env.chainId);

  logger.info(
    'process',
    `Starting server with config: ${config.env.mode} Using forked network: ${network.isForkingEnabled}`
  );

  const orderbookStorage = new OrderbookV1.OrderbookStorage(redis, config.env.chainId);
  const orderbook = new OrderbookV1.Orderbook(orderbookStorage);

  const matchExecutor = new MatchExecutor(config.env.chainId, network.matchExecutorAddress, network.initiator);

  const executionEngine = new ExecutionEngine(
    orderbookStorage,
    redis,
    redlock,
    network.websocketProvider,
    network.httpProvider,
    matchExecutor,
    2,
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

  const orderRelay = new OrderRelay(matchingEngine, firestore, storage, redlock, orderbook, redis, {
    debug: config.env.debug,
    concurrency: 1,
    enableMetrics: false
  });

  logger.info('process', 'Creating matches');
  const matches = await createMatch(config.env.chainId);

  if (matches) {
    for (const match of matches) {
      await orderRelay.add(match.infinityJob);
      await orderRelay.add(match.seaportJob);
    }
  }

  logger.info('process', 'Starting matching engine');
  const matchingEnginePromise = matchingEngine.run();

  logger.info('process', 'Starting order relay');
  const orderRelayPromise = orderRelay.run(false);

  logger.info('process', 'Starting execution engine');
  const executionEnginePromise = executionEngine.run();

  await Promise.all([matchingEnginePromise, orderRelayPromise, executionEnginePromise]);
}

void main();
