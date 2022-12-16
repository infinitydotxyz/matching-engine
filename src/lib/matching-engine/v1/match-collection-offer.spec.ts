import { ChainId } from '@infinityxyz/lib/types/core';

import { redis } from '@/common/db';
import { OrderbookV1 } from '@/lib/orderbook';

import { MatchingEngine } from '.';
import { getOrder } from './get-order';

describe('Matching Engine V1 - Match Token Listing', () => {
  const chainId = ChainId.Mainnet;
  let matchingEngine: MatchingEngine;
  let orderbook: OrderbookV1.Orderbook;
  beforeAll(() => {
    const minOrderStorage = new OrderbookV1.MinOrderStorage(redis, chainId, 'test');
    const rawOrderStorage = new OrderbookV1.RawOrderStorage(redis, chainId, 'test');
    const orderStatusStorage = new OrderbookV1.OrderStatusStorage(redis, chainId, 'test');
    const orderItemStorage = new OrderbookV1.OrderItemStorage(redis, chainId, 'test');
    const storage = new OrderbookV1.OrderbookStorage(
      redis,
      chainId,
      minOrderStorage,
      rawOrderStorage,
      orderStatusStorage,
      orderItemStorage
    );

    orderbook = new OrderbookV1.Orderbook(storage);
    matchingEngine = new MatchingEngine(redis, ChainId.Mainnet, orderbook, orderItemStorage, orderStatusStorage);
  });

  it('should work lol', async () => {
    const tokenListing = getOrder(chainId, 0.1, true, 'single-token', { collection: '0x1', tokenId: '1' });
    const tokenOffer = getOrder(chainId, 0.1, false, 'single-collection', { collection: '0x1' });

    await orderbook.add({ order: tokenListing, status: 'active' });
    await orderbook.add({ order: tokenOffer, status: 'active' });

    const result = await matchingEngine.matchOrder(tokenOffer);
    console.log(result);
    expect(result[0].id).toBeDefined();
  });
});
