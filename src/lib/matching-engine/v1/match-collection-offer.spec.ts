import { ChainId } from '@infinityxyz/lib/types/core';

import { firestore, redis } from '@/common/db';
import { ExecutionEngine } from '@/lib/execution-engine/v1';
import { OrderbookV1 } from '@/lib/orderbook';

import { MatchingEngine } from '.';
import { getOrder } from './get-order';

describe('Matching Engine V1 - Match Token Listing', () => {
  const chainId = ChainId.Mainnet;
  let matchingEngine: MatchingEngine;
  let orderbook: OrderbookV1.Orderbook;
  beforeAll(() => {
    const storage = new OrderbookV1.OrderbookStorage(redis, chainId);
    const executionEngine = new ExecutionEngine(storage, firestore, redis);

    orderbook = new OrderbookV1.Orderbook(storage);
    matchingEngine = new MatchingEngine(redis, ChainId.Mainnet, storage, executionEngine);
  });

  it('should work lol', async () => {
    const tokenListing = getOrder(chainId, 0.1, true, 'single-token', { collection: '0x1', tokenId: '1' });
    const tokenOffer = getOrder(chainId, 0.1, false, 'single-collection', { collection: '0x1' });

    await orderbook.save({ order: tokenListing, status: 'active' });
    await orderbook.save({ order: tokenOffer, status: 'active' });

    const result = await matchingEngine.matchOrder(tokenOffer);
    console.log(result);
    expect(result[0].id).toBeDefined();
  });
});
