/* eslint-disable @typescript-eslint/no-unused-vars */
import { Job } from 'bullmq';
import { BigNumber } from 'ethers/lib/ethers';
import { formatEther, formatUnits } from 'ethers/lib/utils';
import { Redis } from 'ioredis';
import Redlock, { ExecutionError } from 'redlock';

import { ChainId } from '@infinityxyz/lib/types/core';
import { sleep } from '@infinityxyz/lib/utils';

import { config } from '@/config';
import { Match } from '@/lib/match-executor/match/types';
import { OrderbookV1 as OB } from '@/lib/orderbook';
import { Order } from '@/lib/orderbook/v1';
import { OrderData, OrderParams } from '@/lib/orderbook/v1/types';
import { ProcessOptions } from '@/lib/process/types';

import { AbstractMatchingEngine } from '../matching-engine.abstract';

export type MatchingEngineResult = {
  id: string;
  matches: { id: string; value: number }[];
};

export type MatchingEngineJob = { id: string; order: OB.Types.OrderParams };

export class MatchingEngine extends AbstractMatchingEngine<MatchingEngineJob, MatchingEngineResult> {
  public readonly version: string;

  protected _MATCH_LIMIT = 10;

  /**
   * temporary storage for order matches
   */
  protected _getOrderMatchesOrderedSetKey(orderId: string) {
    return `matching-engine:${this.version}:chain:${this._chainId}:order-matches:${orderId}`;
  }

  constructor(
    _db: Redis,
    _chainId: ChainId,
    protected _storage: OB.OrderbookStorage,
    protected _redlock: Redlock,
    public readonly collectionAddress: string,
    options?: ProcessOptions | undefined
  ) {
    const version = 'v1';
    super(_chainId, _db, `matching-engine:${version}:collection:${collectionAddress}`, options);
    this.version = version;
  }

  async processJob(job: Job<MatchingEngineJob>): Promise<MatchingEngineResult> {
    const order = new OB.Order(job.data.order);
    const matches = await this.matchOrder(order);

    const validMatches = await this.processMatches(order, matches);
    const orderId = order.id;

    this.log(`found ${validMatches.length} valid matches for order ${order.id}`);
    if (validMatches.length > 0) {
      type DbMatch = {
        otherOrderIds: string[];
        matchIds: string[];
      };

      const dbMatches = validMatches.reduce((acc, match) => {
        let listingItem = acc.get(match.listing.id);
        let offerItem = acc.get(match.offer.id);

        if (!listingItem) {
          listingItem = {
            otherOrderIds: [match.offer.id],
            matchIds: [match.matchId]
          };
          acc.set(match.listing.id, listingItem);
        } else {
          listingItem.otherOrderIds.push(match.offer.id);
          listingItem.matchIds.push(match.matchId);
        }

        if (!offerItem) {
          offerItem = {
            otherOrderIds: [match.listing.id],
            matchIds: [match.matchId]
          };
          acc.set(match.offer.id, offerItem);
        } else {
          offerItem.otherOrderIds.push(match.listing.id);
          offerItem.matchIds.push(match.matchId);
        }

        return acc;
      }, new Map() as Map<string, DbMatch>);

      const pipeline = this._db.pipeline();

      for (const [orderId, { matchIds }] of dbMatches.entries()) {
        const orderMatchesSet = this._storage.getOrderMatchesSet(orderId);
        const matchIdsArray = [...new Set(matchIds)];
        pipeline.sadd(orderMatchesSet, matchIdsArray);
      }

      for (const match of validMatches) {
        const matchKey = this._storage.getFullMatchKey(match.matchId);
        pipeline.zadd(this._storage.matchesByGasPriceOrderedSetKey, match.maxGasPriceGwei, match.matchId);
        pipeline.set(matchKey, JSON.stringify(match));
      }

      const res = await pipeline.exec();

      if (res) {
        for (const [err] of res) {
          if (err) {
            this.error(`failed to save matches for order ${order.id} ${err}`);
          }
        }
      }
    }

    return {
      id: orderId,
      matches
    };
  }

  public async run() {
    const matchingEngineLock = `matching-engine:chain:${config.env.chainId}:collection:${this.collectionAddress}:lock`;
    const lockDuration = 15_000;
    let failedAttempts = 0;

    while (failedAttempts < 5) {
      try {
        const lockPromise = this._redlock.using([matchingEngineLock], lockDuration, async (signal) => {
          this.log(`Acquired lock`);
          failedAttempts = 0;

          const abortPromise = new Promise((resolve, reject) => {
            signal.onabort = () => {
              reject(new Error('Lock aborted'));
            };
          });

          const runPromise = super._run();
          await Promise.all([abortPromise, runPromise]);
        });
        await lockPromise;
      } catch (err) {
        failedAttempts += 1;
        if (err instanceof ExecutionError) {
          this.warn(`Failed to acquire lock, another instance is syncing. Attempt: ${failedAttempts}`);
        } else {
          this.error(`Unknown error occurred. Attempt: ${failedAttempts} ${JSON.stringify(err)}`);
        }
        await sleep(lockDuration / 3);
      }
    }

    throw new Error('Failed to acquire lock after 5 attempts');
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

    const orderMatches = this._getOrderMatchesOrderedSetKey(order.id);

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

    const orderMatches = this._getOrderMatchesOrderedSetKey(order.id);

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

    return matches;
  }

  async matchCollectionOffer(order: OB.Order, item: { collection: string }) {
    const collectionListingsSet = this._storage.getCollectionTokenListingsSet({
      ...item,
      complication: order.params.complication,
      currency: order.params.currency
    });

    const activeOrdersSet = this._storage.activeOrdersOrderedSetKey;

    const orderMatches = this._getOrderMatchesOrderedSetKey(order.id);

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

  protected async processMatches(order: OB.Order, matches: { id: string; value: number }[]) {
    const mainFullOrderKey = this._storage.getFullOrderKey(order.id);
    const mainFullOrderString = await this._db.get(mainFullOrderKey);
    let mainOrder: OrderData | null;
    try {
      mainOrder = JSON.parse(mainFullOrderString ?? '') as OrderData;
    } catch (err) {
      // mainOrder not found
      mainOrder = null;
    }

    if (!mainOrder) {
      return [] as Match[];
    }

    const mainOrderParams = Order.getOrderParams(mainOrder.id, config.env.chainId, mainOrder.order);

    const matchKeys = matches.map((match) => this._storage.getFullOrderKey(match.id));
    const matchesStrings = matchKeys.length > 0 ? await this._db.mget(...matchKeys) : [];
    const matchesWithFullData = matches.map((item, index) => {
      let orderData: OrderData | null;
      try {
        orderData = JSON.parse(matchesStrings[index] ?? '') as OrderData;
      } catch (err) {
        orderData = null;
      }
      return {
        fullOrderData: orderData,
        matchData: item
      };
    });

    const validMatches: Match[] = [];
    for (const { matchData, fullOrderData: matchOrderData } of matchesWithFullData) {
      if (!matchOrderData) {
        this.error(`order ${matchData.id} not found`);
        continue;
      }

      const orderMatchParams = Order.getOrderParams(matchOrderData.id, config.env.chainId, matchOrderData.order);

      const [offer, listing] = mainOrder.order.isSellOrder ? [matchOrderData, mainOrder] : [mainOrder, matchOrderData];

      const [offerParams, listingParams] = mainOrder.order.isSellOrder
        ? [orderMatchParams, mainOrderParams]
        : [mainOrderParams, orderMatchParams];

      try {
        const executionPrices = this._getExecutionCost(offerParams, listingParams);
        if (executionPrices == null) {
          continue;
        }

        let maxGasPriceGwei;

        /**
         * keep an ordered set of matches where the value is the max gas price (in gwei) that we can execute the trade at
         */
        if (executionPrices.isNative) {
          // as long as the gas price of the offer is above the current gas price, we can execute this order
          maxGasPriceGwei = executionPrices.maxGasPriceGwei;
        } else {
          /**
           * the offer is native, the listing is non-native
           *
           * we can execute the trade if
           * 1. the gas price of the offer is above the current gas price
           * 2. the arbitrage available is above the current gas price * (gas usage + a buffer to pay for other broker expenses)
           *
           * let G1 := arb / (gas usage + a buffer)
           * let G2 := gas price of the native offer
           * max gas price = MIN(G1, G2);
           */
          const bufferGasUsage = 100_000;

          const sourceGasUsage = mainOrder.source === 'flow' ? matchOrderData.gasUsage : mainOrder.gasUsage;
          const gasUsage = parseInt(sourceGasUsage, 10) + bufferGasUsage;
          const maxSourceGasPriceWei = BigNumber.from(executionPrices.arbitrageWei).div(gasUsage);
          const maxSourceGasPriceGwei = parseFloat(formatUnits(maxSourceGasPriceWei, 'gwei'));
          maxGasPriceGwei = Math.min(maxSourceGasPriceGwei, executionPrices.maxGasPriceGwei);
        }

        this.log(`match found: ${offer.id} -> ${listing.id} (maxGasPriceGwei: ${maxGasPriceGwei})`);

        validMatches.push({
          matchId: `${offer.id}:${listing.id}`,
          maxGasPriceGwei,
          isNative: executionPrices.isNative,
          offer,
          listing,
          arbitrageWei: executionPrices.arbitrageWei
        });
      } catch (err) {
        if (err instanceof Error) {
          this.error(`order ${matchData.id} has error. ${err.message}`);
        } else {
          this.error(`order ${matchData.id} has error. ${err}`);
        }
      }
    }
    return validMatches;
  }

  protected _getExecutionCost(offer: OrderParams, listing: OrderParams) {
    if (offer.side === 'sell') {
      throw new Error('offer must be a buy order');
    } else if (listing.side === 'buy') {
      throw new Error('listing must be a sell order');
    }

    const offerPrice = BigNumber.from(offer.startPriceWei);
    const listingPrice = BigNumber.from(listing.startPriceWei);

    if (offerPrice.lt(listingPrice)) {
      return null;
    }

    const bothNative = offer.isNative && listing.isNative;
    if (bothNative) {
      return {
        maxGasPriceGwei: offer.maxTxGasPriceGwei,
        executionPriceWei: listingPrice.toString(),
        executionPriceEth: formatEther(listingPrice.toString()),
        arbitrageWei: '0',
        arbitrageEth: 0,
        isNative: true
      };
    } else if (offer.isNative) {
      const arbitrageWei = offerPrice.sub(listingPrice);
      return {
        maxGasPriceGwei: offer.maxTxGasPriceGwei,
        executionPriceWei: offerPrice.toString(),
        executionPriceEth: formatEther(offerPrice.toString()),
        arbitrageWei: arbitrageWei.toString(),
        arbitrageEth: formatEther(arbitrageWei.toString()),
        isNative: false
      };
    } else if (listing.isNative) {
      throw new Error('non-native offers are not yet supported');
    }
  }
}
