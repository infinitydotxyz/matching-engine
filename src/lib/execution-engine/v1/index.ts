import { BulkJobOptions, Job } from 'bullmq';
import { BigNumber } from 'ethers';
import { formatEther, formatUnits } from 'ethers/lib/utils';
import Redis from 'ioredis';

import { logger } from '@/common/logger';
import { config } from '@/config';
import { OrderbookV1 as OB } from '@/lib/orderbook';
import { Order, OrderbookStorage } from '@/lib/orderbook/v1';
import { OrderData, OrderParams } from '@/lib/orderbook/v1/types';
import { AbstractProcess } from '@/lib/process/process.abstract';
import { ProcessOptions } from '@/lib/process/types';

export type ExecutionEngineJob = {
  /**
   * order id with matches to be executed
   */
  id: string;
  order: OB.Types.OrderParams;
};

export type ExecutionEngineResult = unknown;

export class ExecutionEngine extends AbstractProcess<ExecutionEngineJob, ExecutionEngineResult> {
  protected _version: string;

  constructor(protected _storage: OrderbookStorage, _db: Redis, options?: ProcessOptions) {
    const version = 'v1';
    super(_db, `execution-engine:${version}`, options);
    this._version = version;
  }

  async processJob(job: Job<ExecutionEngineJob, ExecutionEngineResult, string>): Promise<ExecutionEngineResult> {
    const matchesKey = this._storage.getOrderMatchesOrderedSet(job.data.id);
    // const ordersColl = this._firestore.collection(
    //   firestoreConstants.ORDERS_V2_COLL
    // ) as FirebaseFirestore.CollectionReference<RawFirestoreOrder>;

    const mainFullOrderKey = this._storage.getFullOrderKey(job.data.id);
    const mainFullOrderString = await this._db.get(mainFullOrderKey);
    let mainOrder: OrderData | null;
    try {
      mainOrder = JSON.parse(mainFullOrderString ?? '') as OrderData;
    } catch (err) {
      mainOrder = null;
      // mainOrder not found
    }

    if (!mainOrder) {
      throw new Error('Main order not found');
    }

    const mainOrderParams = Order.getOrderParams(mainOrder.id, config.env.chainId, mainOrder.order);

    const getPageArgs = (offset = 0, pageSize = 10) => {
      const args =
        job.data.order.side === 'sell'
          ? [
              matchesKey,
              Number.MAX_SAFE_INTEGER,
              job.data.order.startPriceEth,
              'BYSCORE',
              'REV',
              'LIMIT',
              offset,
              offset + pageSize,
              'WITHSCORES'
            ]
          : [matchesKey, 0, job.data.order.startPriceEth, 'BYSCORE', 'LIMIT', offset, offset + pageSize, 'WITHSCORES'];

      return args as Parameters<Redis['zrange']>;
    };

    let offset = 0;
    const pageSize = 20;
    let hasNextPage = true;
    while (hasNextPage) {
      const pageElements = await this._db.zrange(...getPageArgs(offset, pageSize));

      const matches = this.transformMatchesResult(pageElements);

      offset += matches.length;
      if (matches.length < pageSize) {
        hasNextPage = false;
      }

      const matchesStrings = await this._db.mget(matches.map((match) => this._storage.getFullOrderKey(match.id)));

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

      const validMatches: {
        maxGasPriceGwei: number;
        isNative: boolean;
        offer: OrderData;
        listing: OrderData;
      }[] = [];
      for (const { matchData, fullOrderData: matchOrderData } of matchesWithFullData) {
        if (!matchOrderData) {
          logger.error('execution-engine', `order ${matchData.id} not found`);
          continue;
        }

        const orderMatchParams = Order.getOrderParams(matchOrderData.id, config.env.chainId, matchOrderData.order);

        const [offer, listing] = mainOrder.order.isSellOrder
          ? [matchOrderData, mainOrder]
          : [mainOrder, matchOrderData];

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
             * 2. the arbitrage available is above the current gas price * (gas usage + a buffer to pay for the flashloan/other broker expenses)
             *
             * let G1 := arb / (gas usage + a buffer)
             * let G2 := gas price of the offer
             * max gas price = MIN(G1, G2);
             */
            const bufferGasUsage = 100_000;

            const sourceGasUsage = mainOrder.source === 'infinity' ? matchOrderData.gasUsage : mainOrder.gasUsage;
            const gasUsage = parseInt(sourceGasUsage, 10) + bufferGasUsage;
            const maxSourceGasPriceWei = BigNumber.from(executionPrices.arbitrageWei).div(gasUsage);
            const maxSourceGasPriceGwei = parseFloat(formatUnits(maxSourceGasPriceWei, 'gwei'));
            maxGasPriceGwei = Math.min(maxSourceGasPriceGwei, executionPrices.maxGasPriceGwei);
          }

          validMatches.push({
            maxGasPriceGwei,
            isNative: executionPrices.isNative,
            offer,
            listing
          });
        } catch (err) {
          if (err instanceof Error) {
            logger.error('execution-engine', `order ${matchData.id} has error. ${err.message}`);
          } else {
            logger.error('execution-engine', `order ${matchData.id} has error. ${err}`);
          }
        }
      }

      if (validMatches.length > 0) {
        logger.log('execution-engine', `found ${validMatches.length} valid matches for order ${job.data.order.id}`);
        // TODO save these somewhere
        // make sure it is in sync with order status
        return;
      }
    }
  }

  async add(job: ExecutionEngineJob | ExecutionEngineJob[]): Promise<void> {
    const arr = Array.isArray(job) ? job : [job];
    const jobs: {
      name: string;
      data: ExecutionEngineJob;
      opts?: BulkJobOptions | undefined;
    }[] = arr.map((item) => {
      return {
        name: `${item.id}`,
        data: item
      };
    });
    await this._queue.addBulk(jobs);
  }

  transformMatchesResult(result: (string | number)[]): { id: string; value: number }[] {
    return result.reduce((acc, curr, index) => {
      if (index % 2 === 0) {
        const id = curr.toString();
        const value = result[index + 1] as number;
        acc.push({ id, value });
      }
      return acc;
    }, [] as { id: string; value: number }[]);
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
