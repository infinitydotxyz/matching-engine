import { BulkJobOptions, Job } from 'bullmq';
import { BigNumber, constants, ethers } from 'ethers';
import Redis from 'ioredis';
import Redlock, { ExecutionError, RedlockAbortSignal } from 'redlock';

import { logger } from '@/common/logger';
import { config } from '@/config';
import { Match } from '@/lib/matching-engine/v1';
import { OrderbookStorage } from '@/lib/orderbook/v1';
import { AbstractProcess } from '@/lib/process/process.abstract';
import { ProcessOptions } from '@/lib/process/types';

export type ExecutionEngineJob = {
  id: string;
  currentBlockNumber: number;
  currentGasPriceWei: string;
  currentGasPriceGwei: number;
  targetBlockNumber: number;
};

export type ExecutionEngineResult = unknown;

export class ExecutionEngine extends AbstractProcess<ExecutionEngineJob, ExecutionEngineResult> {
  protected _version: string;

  constructor(
    protected _storage: OrderbookStorage,
    _db: Redis,
    protected _redlock: Redlock,
    protected _websocketProvider: ethers.providers.WebSocketProvider,
    protected _rpcProvider: ethers.providers.JsonRpcProvider,
    protected _blockOffset: number,
    options?: ProcessOptions
  ) {
    const version = 'v1';
    super(_db, `execution-engine:${version}`, options);
    this._version = version;
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

  public async run(): Promise<void> {
    const blockListenerLockKey = `execution-engine:chain:${config.env.chainId}:lock`;
    const lockDuration = 15_000;
    /**
     * start processing jobs from the queue
     */
    const runPromise = super._run().catch((err: Error) => {
      logger.error('execution-engine', `Unexpected error: ${err.message}`);
    });
    const listenPromise = this._redlock
      .using([blockListenerLockKey], lockDuration, async (signal) => {
        /**
         * listen for blocks
         */
        await this._listen(signal);
      })
      .catch((err) => {
        if (err instanceof ExecutionError) {
          logger.warn('execution-engine', 'Failed to acquire lock, another instance is syncing');
        } else {
          throw err;
        }
      });

    await Promise.all([runPromise, listenPromise]);
  }

  async processJob(job: Job<ExecutionEngineJob, unknown, string>): Promise<unknown> {
    const targetGasPriceGwei = Math.ceil(job.data.currentGasPriceGwei);
    logger.log(
      'execution-engine',
      `Generating txn for target: ${job.data.targetBlockNumber}. Current Gas Price: ${job.data.currentGasPriceGwei} gwei. Target gas price: ${targetGasPriceGwei} gwei`
    );

    const matches = await this._loadMatches(targetGasPriceGwei);
    const sortedMatches = this._sortMatches(matches);
    const nonConflictingMatches = this._filterConflicting(sortedMatches);

    logger.log(
      'execution-engine',
      `Block" ${job.data.targetBlockNumber}. Target gas price: ${targetGasPriceGwei} gwei. Found ${matches.length} order matches. ${nonConflictingMatches.length} non-conflicting order matches`
    );

    await Promise.resolve();
    return;
  }

  protected async _loadMatches(targetGasPriceGwei: number) {
    const res = await this._db.zrange(
      this._storage.matchesByGasPriceOrderedSetKey,
      targetGasPriceGwei,
      Number.MAX_SAFE_INTEGER,
      'REV'
    );

    const fullMatchKeys = res.map(this._storage.getFullMatchKey.bind(this._storage));
    const fullMatchStrings = await this._db.mget(...fullMatchKeys);

    const fullMatches = fullMatchStrings
      .map((item) => {
        try {
          const match = JSON.parse(item ?? '') as Match;
          return match;
        } catch (err) {
          return null;
        }
      })
      .filter((item) => !!item) as Match[];

    return fullMatches;
  }

  protected _sortMatches(matches: Match[]) {
    return matches.sort((a, b) => {
      const preferA = -1;
      const preferB = 1;
      const arbA = BigNumber.from(a.arbitrageWei);
      if (arbA.gt(b.arbitrageWei)) {
        return preferA;
      } else if (arbA.eq(b.arbitrageWei)) {
        const offerAStartTime = BigNumber.from(a.offer.order.constraints[3]);
        const offerBStartTime = b.offer.order.constraints[3];
        if (offerAStartTime.lt(offerBStartTime)) {
          return preferA;
        }
        return preferB;
      }
      return preferB;
    });
  }

  protected _filterConflicting(matches: Match[]) {
    const orderIds = new Set<string>();
    const wallets = new Set<string>();

    const tokens = new Set<string>();

    const nonConflictingMatches = matches.filter((match) => {
      /**
       * don't attempt to execute the same order multiple times
       */
      const listingId = match.listing.id;
      const offerId = match.offer.id;
      if (orderIds.has(listingId) || orderIds.has(offerId)) {
        return false;
      }

      /**
       * limit each user to a single executing order at a time
       */
      const listingMaker = match.listing.order.signer;
      const offerMaker = match.offer.order.signer;
      if (wallets.has(listingMaker) && listingMaker !== constants.AddressZero) {
        return false;
      } else if (wallets.has(offerMaker) && offerMaker !== constants.AddressZero) {
        return false;
      }

      /**
       * only attempt to execute orders for unique tokens
       */
      const listingTokens = match.listing.order.nfts.flatMap(({ collection, tokens }) => {
        return tokens.map((token) => `${collection}:${token.tokenId}`);
      });
      for (const tokenString of listingTokens) {
        if (tokens.has(tokenString)) {
          return false;
        }
      }

      listingTokens.forEach((token) => tokens.add(token));
      wallets.add(listingMaker);
      wallets.add(offerMaker);
      orderIds.add(listingId);
      orderIds.add(offerId);
      return true;
    });

    return nonConflictingMatches;
  }

  protected async _listen(signal: RedlockAbortSignal) {
    let cancel: (error: Error) => void = () => {
      return;
    };

    const handler = async (blockNumber: number) => {
      try {
        this._checkSignal(signal);
      } catch (err) {
        if (err instanceof Error) {
          cancel(err);
        } else {
          const errorMessage = `Unexpected error: ${err}`;
          cancel(new Error(errorMessage));
        }
        return;
      }

      try {
        const currentGasPrice = await this._rpcProvider.getGasPrice();
        const currentGasPriceGwei = parseFloat(ethers.utils.formatUnits(currentGasPrice, 'gwei'));
        const job: ExecutionEngineJob = {
          id: `${config.env.chainId}:${blockNumber}`,
          currentBlockNumber: blockNumber,
          currentGasPriceWei: currentGasPrice.toString(),
          currentGasPriceGwei,
          targetBlockNumber: blockNumber + this._blockOffset
        };

        await this.add(job);
      } catch (err) {
        if (err instanceof Error) {
          logger.error('execution-engine', `Unexpected error: ${err.message}`);
        } else {
          logger.error('execution-engine', `Unexpected error: ${err}`);
        }
      }
    };

    return new Promise((reject) => {
      cancel = (err: Error) => {
        this._websocketProvider.off('block', handler);
        reject(err);
      };
      this._websocketProvider.on('block', handler);
    });
  }

  protected _checkSignal(signal: RedlockAbortSignal) {
    if (signal.aborted) {
      throw signal.error;
    }
  }
}
