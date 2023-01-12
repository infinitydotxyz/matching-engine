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
    const storage = new OrderbookV1.OrderbookStorage(redis, chainId);

    orderbook = new OrderbookV1.Orderbook(storage);
    matchingEngine = new MatchingEngine(redis, ChainId.Mainnet, storage);
  });

  it('should work lol', async () => {
    const { orderData: tokenListingData } = getOrder(chainId, 0.1, true, 'single-token', {
      collection: '0x1',
      tokenId: '1'
    });
    const { orderData: tokenOfferData, order: tokenOffer } = getOrder(chainId, 0.1, false, 'single-collection', {
      collection: '0x1'
    });

    await orderbook.save(tokenListingData);
    await orderbook.save(tokenOfferData);

    const result = await matchingEngine.matchOrder(tokenOffer);
    console.log(result);
    expect(result[0].id).toBeDefined();
  });
});
