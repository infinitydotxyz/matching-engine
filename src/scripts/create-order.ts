import { ChainId } from '@infinityxyz/lib/types/core';

import { redis } from '@/common/db';
import { logger } from '@/common/logger';
import { config } from '@/config';
import { MatchingEngine } from '@/lib/matching-engine/v1';
import { getOrder } from '@/lib/matching-engine/v1/get-order';
import { OrderbookV1 } from '@/lib/orderbook';

export async function main() {
  const listing = getOrder(ChainId.Mainnet, 1, true, 'single-token', { collection: '0x2', tokenId: '1' });
  const offer = getOrder(ChainId.Mainnet, 1, false, 'single-token', { collection: '0x2', tokenId: '1' });

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
  const matchingEngine = new MatchingEngine(
    redis,
    config.env.chainId,
    orderbook,
    orderItemStorage,
    orderStatusStorage,
    {
      debug: config.env.debug,
      concurrency: 1,
      enableMetrics: false
    }
  );

  const order = listing;
  await orderbook.add({ order: order, status: 'active' });

  await matchingEngine.add(order.params);
  logger.log('process', 'order added');
  process.exit(1);
}

void main();
