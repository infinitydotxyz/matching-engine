import { config } from '@/config';

import { redis } from './common/db';
import { logger } from './common/logger';
import { MatchingEngine } from './lib/matching-engine/v1';
import { OrderbookV1 } from './lib/orderbook';

process.on('unhandledRejection', (error) => {
  logger.error('process', `Unhandled rejection: ${error}`);
});

logger.info('process', `Starting server with config: ${config.env.mode}`);

async function main() {
  const minOrderStorage = new OrderbookV1.MinOrderStorage(redis, config.env.chainId, 'v1');
  const rawOrderStorage = new OrderbookV1.RawOrderStorage(redis, config.env.chainId, 'v1');
  const orderStatusStorage = new OrderbookV1.OrderStatusStorage(redis, config.env.chainId, 'v1');
  const orderItemStorage = new OrderbookV1.OrderItemStorage(redis, config.env.chainId, 'v1');
  const storage = new OrderbookV1.OrderbookStorage(
    redis,
    config.env.chainId,
    minOrderStorage,
    rawOrderStorage,
    orderStatusStorage,
    orderItemStorage
  );
  const orderbook = new OrderbookV1.Orderbook(storage);
  const matchingEngine = new MatchingEngine(redis, config.env.chainId, orderItemStorage, orderStatusStorage, {
    debug: config.env.debug,
    concurrency: 1,
    enableMetrics: false
  });

  logger.info('process', 'Starting matching engine');
  await matchingEngine.run();
}

void main();
