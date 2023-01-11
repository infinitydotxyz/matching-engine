import { BulkJobOptions, Job } from 'bullmq';
import { BigNumber, ethers } from 'ethers';
import { parseUnits } from 'ethers/lib/utils';
import Redis from 'ioredis';
import Redlock, { ExecutionError, RedlockAbortSignal } from 'redlock';

import { ONE_MIN } from '@infinityxyz/lib/utils';

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
    super(_db, `execution-engine:${version}`, { ...options, attempts: 1 });
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

      const [matches, pendingOrders] = await Promise.all([
        this._loadMatches(targetGasPriceGwei),
        this._loadPendingOrderIds()
      ]);
      const nonPendingMatches = this._filterPendingOrders(matches, pendingOrders);
      const sortedMatches = this._sortMatches(nonPendingMatches);
      const nonConflictingMatches = sortedMatches; // TODO validate and select matches

      logger.log(
        'execution-engine',
        `Block" ${job.data.targetBlockNumber}. Target gas price: ${targetGasPriceGwei} gwei. Found ${matches.length} order matches. ${nonConflictingMatches.length} non-conflicting order matches`
      );

      const res = await this._generateTxn(nonConflictingMatches, targetBaseFeeGwei, targetPriorityFeeGwei);
      if (!res) {
        logger.log('execution-engine', `Block ${job.data.targetBlockNumber}. No matches found`);
        return;
      }
      const { txn, receipt } = res;

      if (receipt.status === 1) {
        const gasUsage = receipt.gasUsed.toString();
        await this._savePendingMatches(nonConflictingMatches);
        logger.log(
          'execution-engine',
          `Block ${job.data.targetBlockNumber}. Txn ${txn.hash} executed successfully. Gas used: ${gasUsage}`
        );
      } else {
        logger.log('execution-engine', `Block ${job.data.targetBlockNumber}. Txn ${txn.hash} execution failed`);
      }
    } catch (err) {
      logger.error('execution-engine', `failed to process job for block ${job.data.targetBlockNumber} ${err}`);
      process.exit(1);
    }

    await Promise.resolve();
    return;
  }

  protected async _generateTxn(matches: Match[], baseFeeGwei: number, priorityFeeGwei: number) {
    if (matches.length === 0) {
      return null;
    }
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

    logger.log(`execution-engine`, `Txn: ${JSON.stringify(txn, null, 2)}`);

    const res = await this._broadcaster.broadcast(txn);

    return {
      batches,
      txn: res.txn,
      receipt: res.receipt
    };
  }

  protected _filterPendingOrders(matches: Match[], pendingOrders: Set<string>) {
    return matches.filter((match) => {
      return !pendingOrders.has(match.listing.id) && !pendingOrders.has(match.offer.id);
    });
  }

  protected async _savePendingMatches(matches: Match[]) {
    const pipeline = this._db.pipeline();
    const now = Date.now();
    const expiration = now + ONE_MIN * 5;
    for (const match of matches) {
      pipeline.zadd(this._storage.executedOrdersOrderedSetKey, expiration, match.listing.id);
      pipeline.zadd(this._storage.executedOrdersOrderedSetKey, expiration, match.offer.id);
    }
    await pipeline.exec(); // TODO remove expired orders from the set
  }

  protected async _loadPendingOrderIds() {
    const now = Date.now();
    const res = await this._db.zrange(
      this._storage.executedOrdersOrderedSetKey,
      Number.MAX_SAFE_INTEGER,
      now,
      'BYSCORE',
      'REV'
    );

    return new Set(res);
  }

  protected async _loadMatches(targetGasPriceGwei: number) {
    const res = await this._db.zrange(
      this._storage.matchesByGasPriceOrderedSetKey,
      Number.MAX_SAFE_INTEGER,
      targetGasPriceGwei,
      'BYSCORE',
      'REV',
      'LIMIT',
      0,
      1000
    );

    const fullMatchKeys = res.map(this._storage.getFullMatchKey.bind(this._storage));
    const fullMatchStrings = fullMatchKeys.length > 0 ? await this._db.mget(...fullMatchKeys) : [];

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

  // protected _filterConflicting(matches: Match[]) {
  //   const orderIds = new Set<string>();
  //   // const wallets = new Set<string>();

  //   const tokens = new Set<string>();

  //   const nonConflictingMatches = matches.filter((match) => {
  //     /**
  //      * don't attempt to execute the same order multiple times
  //      */
  //     const listingId = match.listing.id;
  //     const offerId = match.offer.id;
  //     if (orderIds.has(listingId) || orderIds.has(offerId)) {
  //       return false;
  //     }

  //     // TODO configure filtering on wallets to be based on transferred tokens and invalid balances
  //     // /**
  //     //  * limit each user to a single executing order at a time
  //     //  */
  //     // const listingMaker = match.listing.order.signer;
  //     // const offerMaker = match.offer.order.signer;
  //     // if (wallets.has(listingMaker) && listingMaker !== constants.AddressZero) {
  //     //   return false;
  //     // } else if (wallets.has(offerMaker) && offerMaker !== constants.AddressZero) {
  //     //   return false;
  //     // }

  //     /**
  //      * only attempt to execute orders for unique tokens
  //      */
  //     const listingTokens = match.listing.order.nfts.flatMap(({ collection, tokens }) => {
  //       return tokens.map((token) => `${collection}:${token.tokenId}`);
  //     });
  //     for (const tokenString of listingTokens) {
  //       if (tokens.has(tokenString)) {
  //         return false;
  //       }
  //     }

  //     listingTokens.forEach((token) => tokens.add(token));
  //     // wallets.add(listingMaker);
  //     // wallets.add(offerMaker);
  //     orderIds.add(listingId);
  //     orderIds.add(offerId);
  //     return true;
  //   });

  //   return nonConflictingMatches;
  // }

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
