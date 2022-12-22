import { config } from '@/config';

import { firestore, redis, redlock, storage } from './common/db';
import { logger } from './common/logger';
import { ExecutionEngine } from './lib/execution-engine/v1';
import { MatchingEngine } from './lib/matching-engine/v1';
import { OrderRelay } from './lib/order-relay/v1/order-relay';
import { OrderbookV1 } from './lib/orderbook';

process.on('unhandledRejection', (error) => {
  logger.error('process', `Unhandled rejection: ${error}`);
});

logger.info('process', `Starting server with config: ${config.env.mode}`);

async function main() {
  const orderbookStorage = new OrderbookV1.OrderbookStorage(redis, config.env.chainId);
  const orderbook = new OrderbookV1.Orderbook(orderbookStorage);
  const executionEngine = new ExecutionEngine(orderbookStorage, firestore, redis, {
    debug: config.env.debug,
    concurrency: 1,
    enableMetrics: false
  });

  const matchingEngine = new MatchingEngine(redis, config.env.chainId, orderbookStorage, executionEngine, {
    debug: config.env.debug,
    concurrency: 1,
    enableMetrics: false
  });

  const orderRelay = new OrderRelay(matchingEngine, firestore, storage, redlock, orderbook, redis, {
    debug: config.env.debug,
    concurrency: 1,
    enableMetrics: false
  });

  logger.info('process', 'Starting matching engine');
  const matchingEnginePromise = matchingEngine.run();

  logger.info('process', 'Starting order relay');
  const orderRelayPromise = orderRelay.run();

  logger.info('process', 'Starting execution engine');
  const executionEnginePromise = executionEngine.run();

  await Promise.all([matchingEnginePromise, orderRelayPromise, executionEnginePromise]);
}

void main();
