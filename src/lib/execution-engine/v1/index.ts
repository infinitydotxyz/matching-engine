import { BulkJobOptions, Job } from 'bullmq';
import { BigNumber, constants, ethers } from 'ethers';
import { parseUnits } from 'ethers/lib/utils';
import Redis from 'ioredis';
import Redlock, { ExecutionError, RedlockAbortSignal } from 'redlock';

import { logger } from '@/common/logger';
import { config } from '@/config';
import { Broadcaster } from '@/lib/broadcaster/broadcaster.abstract';
import { MatchExecutor } from '@/lib/match-executor/match-executor';
import { Match } from '@/lib/match-executor/match/types';
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

export class ExecutionEngine<T> extends AbstractProcess<ExecutionEngineJob, ExecutionEngineResult> {
  protected _version: string;

  constructor(
    protected _storage: OrderbookStorage,
    _db: Redis,
    protected _redlock: Redlock,
    protected _websocketProvider: ethers.providers.WebSocketProvider,
    protected _rpcProvider: ethers.providers.JsonRpcProvider,
    protected _matchExecutor: MatchExecutor,
    protected _blockOffset: number,
    protected _broadcaster: Broadcaster<T>,
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
    try {
      const targetBaseFeeGwei = Math.ceil(job.data.currentGasPriceGwei) + 2;
      const targetPriorityFeeGwei = 3;
      const targetGasPriceGwei = targetBaseFeeGwei + targetPriorityFeeGwei;

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

      const txn = await this._generateTxn(nonConflictingMatches, targetBaseFeeGwei, targetPriorityFeeGwei);
    } catch (err) {
      console.error(`failed to process job for block ${job.data.targetBlockNumber}`);
      process.exit(1);
    }

    await Promise.resolve();
    return;
  }

  protected async _generateTxn(matches: Match[], baseFeeGwei: number, priorityFeeGwei: number) {
    const { batches } = await this._matchExecutor.executeMatchesTxn(matches);

    const baseFeeWei = parseUnits(baseFeeGwei.toString(), 'gwei');
    const priorityFeeWei = parseUnits(priorityFeeGwei.toString(), 'gwei');
    const maxFeePerGas = baseFeeWei.add(priorityFeeWei);
    const { txn } = this._matchExecutor.getTxn({
      batches,
      maxFeePerGas: maxFeePerGas,
      maxPriorityFeePerGas: priorityFeeWei,
      gasLimit: 30_000_000
    });

    const res = await this._broadcaster.broadcast(txn);

    console.log(JSON.stringify(res.receipt, null, 2));

    return {
      batches,
      txn: res.txn,
      receipt: res.receipt
    };
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
      logger.log('Block listener', `Received block ${blockNumber}`);

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
