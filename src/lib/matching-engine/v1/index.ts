/* eslint-disable @typescript-eslint/no-unused-vars */
import { BulkJobOptions, Job } from 'bullmq';
import { Redis } from 'ioredis';

import { ChainId } from '@infinityxyz/lib/types/core';

import { ExecutionEngine } from '@/lib/execution-engine/v1';
import { OrderbookV1 as OB } from '@/lib/orderbook';
import { ProcessOptions } from '@/lib/process/types';

import { AbstractMatchingEngine } from '../matching-engine.abstract';

export type MatchingEngineResult = {
  id: string;
  matches: { id: string; value: number }[];
};

export type MatchingEngineJob = { id: string; order: OB.Types.OrderParams };

export class MatchingEngine extends AbstractMatchingEngine<MatchingEngineJob, MatchingEngineResult> {
  public readonly version: string;

  protected _MATCH_LIMIT = 50;

  public getOrderMatchesOrderedSetKey(orderId: string) {
    return `matching-engine:${this.version}:chain:${this._chainId}:order-matches:${orderId}`;
  }

  constructor(
    _db: Redis,
    _chainId: ChainId,
    protected _storage: OB.OrderbookStorage,
    protected _executionEngine: ExecutionEngine,
    options?: ProcessOptions | undefined
  ) {
    const version = 'v1';
    super(_chainId, _db, `matching-engine:${version}`, options);
    this.version = version;
  }

  async processJob(job: Job<MatchingEngineJob>): Promise<MatchingEngineResult> {
    const order = new OB.Order(job.data.order);
    const matches = await this.matchOrder(order);

    const orderId = order.id;

    if (matches.length > 0) {
      let pipeline = this._db.pipeline();
      for (const match of matches) {
        // TODO note the race condition here with an order getting deleted
        pipeline = pipeline
          .zadd(this._storage.getOrderMatchesOrderedSet(orderId), match.value, match.id)
          .zadd(this._storage.getOrderMatchesOrderedSet(match.id), match.value, orderId);
      }
      await pipeline.exec();
      await this._executionEngine.add({
        id: orderId,
        order: job.data.order
      });
    }

    return {
      id: orderId,
      matches
    };
  }

  async add(job: MatchingEngineJob | MatchingEngineJob[]): Promise<void> {
    const arr = Array.isArray(job) ? job : [job];
    const jobs: {
      name: string;
      data: MatchingEngineJob;
      opts?: BulkJobOptions | undefined;
    }[] = arr.map((item) => {
      return {
        name: `${item.id}`,
        data: item
      };
    });
    await this._queue.addBulk(jobs);
  }

  async matchOrder(order: OB.Order): Promise<
    {
      id: string;
      value: number;
    }[]
  > {
    const orderItem = order.getOrderItem();

    if (order.params.side === 'buy' && 'tokenId' in orderItem) {
      return await this.matchTokenOffer(order, orderItem);
    } else if (order.params.side === 'sell' && 'tokenId' in orderItem) {
      return await this.matchTokenListing(order, orderItem);
    } else if (order.params.side === 'buy') {
      return await this.matchCollectionOffer(order, orderItem);
    } else {
      throw new Error('Not implemented');
    }
  }

  async matchTokenOffer(order: OB.Order, item: { collection: string; tokenId: string }) {
    const tokenListingSet = this._storage.getTokenListingsSet({
      ...item,
      complication: order.params.complication,
      currency: order.params.currency
    });

    const activeOrdersSet = this._storage.activeOrdersOrderedSetKey;

    const orderMatches = this.getOrderMatchesOrderedSetKey(order.id);

    const matches = await new Promise<{ id: string; value: number }[]>((resolve, reject) => {
      this._db
        .pipeline()
        .zinterstore(orderMatches, 2, tokenListingSet, activeOrdersSet, 'AGGREGATE', 'MAX')
        .zrange(orderMatches, 0, order.params.startPriceEth, 'BYSCORE', 'LIMIT', 0, this._MATCH_LIMIT, 'WITHSCORES')
        .del(orderMatches)
        .exec()
        .then((results) => {
          if (!results) {
            reject(new Error('No matches found'));
            return;
          }
          const [[interstoreErr, numMatches], [matchesErr, matchesResult]] = results;

          if (interstoreErr) {
            reject(interstoreErr);
            return;
          } else if (matchesErr) {
            reject(matchesErr);
            return;
          }

          resolve(this.transformResult(matchesResult as (string | number)[]));
          return;
        })
        .catch((err) => {
          reject(err);
        });
    });
    return matches;
  }

  async matchTokenListing(order: OB.Order, item: { collection: string; tokenId: string }) {
    const tokenOffersSet = this._storage.getTokenOffersSet({
      ...item,
      complication: order.params.complication,
      currency: order.params.currency
    });

    const collectionOffersSet = this._storage.getCollectionWideOffersSet({
      collection: item.collection,
      complication: order.params.complication,
      currency: order.params.currency
    });

    const activeOrdersSet = this._storage.activeOrdersOrderedSetKey;

    const orderMatches = this.getOrderMatchesOrderedSetKey(order.id);

    const activeTokenOffers = `matching-engine:${this.version}:chain:${this._chainId}:tmp:${order.id}:type:active-token-offers`;
    const activeCollectionOffers = `matching-engine:${this.version}:chain:${this._chainId}:tmp:${order.id}:type:active-collection-offers`;

    const matches = await new Promise<{ id: string; value: number }[]>((resolve, reject) => {
      this._db
        .pipeline()
        /**
         * we perform separate intersections with active orders under the assumption that
         * we are not pruning inactive orders - if this is not the case it is likely more performant
         * to perform a union of token offers and collection offers then intersect with active orders
         */
        .zinterstore(activeTokenOffers, 2, tokenOffersSet, activeOrdersSet, 'AGGREGATE', 'MAX')
        .zinterstore(activeCollectionOffers, 2, collectionOffersSet, activeOrdersSet, 'AGGREGATE', 'MAX')
        .zunionstore(orderMatches, 2, activeCollectionOffers, activeTokenOffers, 'AGGREGATE', 'MAX')
        .zrange(
          orderMatches,
          Number.MAX_SAFE_INTEGER,
          order.params.startPriceEth, // TODO make sure we handle floating point numbers correctly
          'BYSCORE',
          'REV',
          'LIMIT',
          0,
          this._MATCH_LIMIT,
          'WITHSCORES'
        )
        .del(orderMatches, activeTokenOffers, activeCollectionOffers)
        .exec()
        .then((results) => {
          if (!results) {
            reject(new Error('No matches found'));
            return;
          }

          const [activeTokenOffersResult, activeCollectionOffersResult, allActiveOrdersResult, orderMatchesResult] =
            results;

          if (activeTokenOffersResult[0]) {
            reject(activeTokenOffersResult[0]);
            return;
          } else if (activeCollectionOffersResult[0]) {
            reject(activeCollectionOffersResult[0]);
            return;
          } else if (allActiveOrdersResult[0]) {
            reject(allActiveOrdersResult[0]);
            return;
          } else if (orderMatchesResult[0]) {
            reject(orderMatchesResult[0]);
            return;
          }

          resolve(this.transformResult(orderMatchesResult[1] as (string | number)[]));
          return;
        })
        .catch((err) => {
          reject(err);
        });
    });

    // TODO handle pending orders
    return matches;
  }

  async matchCollectionOffer(order: OB.Order, item: { collection: string }) {
    const collectionListingsSet = this._storage.getCollectionTokenListingsSet({
      ...item,
      complication: order.params.complication,
      currency: order.params.currency
    });

    const activeOrdersSet = this._storage.activeOrdersOrderedSetKey;

    const orderMatches = this.getOrderMatchesOrderedSetKey(order.id);

    const matches = await new Promise<{ id: string; value: number }[]>((resolve, reject) => {
      this._db
        .pipeline()
        .zinterstore(orderMatches, 2, collectionListingsSet, activeOrdersSet, 'AGGREGATE', 'MAX')
        .zrange(orderMatches, 0, order.params.startPriceEth, 'BYSCORE', 'LIMIT', 0, this._MATCH_LIMIT, 'WITHSCORES')
        .del(orderMatches)
        .exec()
        .then((results) => {
          if (!results) {
            reject(new Error('No matches found'));
            return;
          }
          const [[interstoreErr, numMatches], [matchesErr, matchesResult]] = results;

          if (interstoreErr) {
            reject(interstoreErr);
            return;
          } else if (matchesErr) {
            reject(matchesErr);
            return;
          }

          resolve(this.transformResult(matchesResult as (string | number)[]));
          return;
        })
        .catch((err) => {
          reject(err);
        });
    });

    return matches;
  }

  matchCollectionListing(order: OB.Order) {
    throw new Error('Not Supported');
  }

  transformResult(result: (string | number)[]): { id: string; value: number }[] {
    return result.reduce((acc, curr, index) => {
      if (index % 2 === 0) {
        const id = curr.toString();
        const value = result[index + 1] as number;
        acc.push({ id, value });
      }
      return acc;
    }, [] as { id: string; value: number }[]);
  }
}
