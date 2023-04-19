import { ChainId } from '@infinityxyz/lib/types/core';
import { getOBComplicationAddress } from '@infinityxyz/lib/utils';

import { firestore } from '@/common/firestore';
import { redis, redlock } from '@/common/redis';
import { OrderbookV1 } from '@/lib/orderbook';

import { MatchingEngine } from '.';
import { getOrder } from './get-order';

describe('Matching Engine V1 - Match Token Listing', () => {
  const chainId = ChainId.Mainnet;
  const collection = '0x1';
  let matchingEngine: MatchingEngine;
  let orderbook: OrderbookV1.Orderbook;
  beforeAll(() => {
    const storage = new OrderbookV1.OrderbookStorage(redis, firestore, chainId);
    const complication = getOBComplicationAddress(chainId);
    orderbook = new OrderbookV1.Orderbook(storage, new Set(complication));
    matchingEngine = new MatchingEngine(redis, ChainId.Mainnet, storage, redlock, collection);
  });

  it('should work lol', async () => {
    const { orderData: tokenListingData, order: tokenListing } = getOrder(chainId, 0.1, true, 'single-token', {
      collection,
      tokenId: '1'
    });
    const { orderData: tokenOfferData } = getOrder(chainId, 0.1, false, 'single-token', {
      collection,
      tokenId: '1'
    });

    await orderbook.save(tokenListingData);
    await orderbook.save(tokenOfferData);

    const result = await matchingEngine.matchOrder(tokenListing);
    console.log(result);
    expect(result[0].id).toBeDefined();
  });
});
