import { firestore, redis, redlock, storage } from '@/common/db';
import { config } from '@/config';
import { MatchingEngine } from '@/lib/matching-engine/v1';
import { OrderRelay } from '@/lib/order-relay/v1/order-relay';
import {
  MinOrderStorage,
  OrderItemStorage,
  OrderStatusStorage,
  Orderbook,
  OrderbookStorage,
  RawOrderStorage
} from '@/lib/orderbook/v1';

async function main() {
  const orderItemStorage = new OrderItemStorage(redis, config.env.chainId, 'v1');
  const orderStatusStorage = new OrderStatusStorage(redis, config.env.chainId, 'v1');
  const minOrderStorage = new MinOrderStorage(redis, config.env.chainId, 'v1');
  const rawOrderStorage = new RawOrderStorage(redis, config.env.chainId, 'v1');
  const orderbookStorage = new OrderbookStorage(
    redis,
    config.env.chainId,
    minOrderStorage,
    rawOrderStorage,
    orderStatusStorage,
    orderItemStorage
  );
  const orderbook = new Orderbook(orderbookStorage);
  const matchingEngine = new MatchingEngine(redis, config.env.chainId, orderItemStorage, orderStatusStorage);
  const orderRelay = new OrderRelay(matchingEngine, firestore, storage, redlock, orderbook, redis, 'order-relay', {
    debug: true
  });

  await orderRelay.run();
}

void main();
