import { BulkJobOptions, Job } from 'bullmq';
import { BigNumber, BigNumberish, ethers } from 'ethers';
import { parseUnits } from 'ethers/lib/utils';
import Redis from 'ioredis';
import PQueue from 'p-queue';
import Redlock, { ExecutionError, RedlockAbortSignal } from 'redlock';

import { ERC20ABI, ERC721ABI } from '@infinityxyz/lib/abi';
import { ChainId } from '@infinityxyz/lib/types/core';
import { ONE_MIN } from '@infinityxyz/lib/utils';
import { Common } from '@reservoir0x/sdk';

import { logger } from '@/common/logger';
import { config } from '@/config';
import { Broadcaster } from '@/lib/broadcaster/broadcaster.abstract';
import { MatchExecutor } from '@/lib/match-executor/match-executor';
import { NativeMatch } from '@/lib/match-executor/match/native-match';
import { NonNativeMatch } from '@/lib/match-executor/match/non-native-match';
import { Match, NativeMatchExecutionInfo, NonNativeMatchExecutionInfo } from '@/lib/match-executor/match/types';
import { OrderFactory } from '@/lib/match-executor/order/infinity';
import { OrderExecutionSimulator } from '@/lib/match-executor/simulator/order-execution-simulator';
import { ExecutionState, Transfer, TransferKind } from '@/lib/match-executor/simulator/types';
import { Batch, ExternalFulfillments, MatchOrders } from '@/lib/match-executor/types';
import { OrderbookStorage } from '@/lib/orderbook/v1';
import { AbstractProcess } from '@/lib/process/process.abstract';
import { ProcessOptions } from '@/lib/process/types';
import { Invalid, ValidityResult } from '@/lib/utils/validity-result';

export type ExecutionEngineJob = {
  id: string;
  currentBlockNumber: number;
  currentBlockTimestamp: number;
  currentGasPriceWei: string;
  currentGasPriceGwei: number;
  targetBlockNumber: number;
  targetBlockTimestamp: number;
};

export type ExecutionEngineResult = unknown;

export class ExecutionEngine<T> extends AbstractProcess<ExecutionEngineJob, ExecutionEngineResult> {
  protected _version: string;

  constructor(
    protected _chainId: ChainId,
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

      const targetBlock = {
        timestamp: job.data.targetBlockTimestamp,
        blockNumber: job.data.targetBlockNumber,
        gasPrice: targetGasPriceGwei
      };

      logger.log(
        'execution-engine',
        `Generating txn for target: ${job.data.targetBlockNumber}. Current Gas Price: ${job.data.currentGasPriceGwei} gwei. Target gas price: ${targetGasPriceGwei} gwei`
      );

      const [matches, pendingOrders] = await Promise.all([
        this._loadMatches(targetGasPriceGwei),
        this._loadPendingOrderIds()
      ]);
      const nonPendingMatches = this._filterPendingOrders(matches, pendingOrders);
      const orderDurationSeconds = 3 * 60;
      const orderFactory = new OrderFactory(
        this._chainId,
        this._rpcProvider,
        this._matchExecutor.nonceProvider,
        this._matchExecutor.address,
        this._matchExecutor.owner,
        orderDurationSeconds
      );
      const sortedMatches = this._sortMatches(nonPendingMatches).map((item) => {
        if (item.isNative) {
          return new NativeMatch(item, this._chainId, orderFactory);
        }
        return new NonNativeMatch(item, this._chainId, orderFactory, this._rpcProvider, this._matchExecutor.address);
      });

      logger.log(
        'execution-engine',
        `Block ${job.data.targetBlockNumber}. Found ${matches.length} order matches before simulation.`
      );

      const nonConflictingMatches = await this.simulate(sortedMatches, targetBlock, {
        timestamp: job.data.currentBlockTimestamp,
        blockNumber: job.data.currentBlockNumber,
        gasPrice: job.data.currentGasPriceGwei
      });

      logger.log(
        'execution-engine',
        `Block ${job.data.targetBlockNumber}. Target gas price: ${targetGasPriceGwei} gwei. Found ${nonConflictingMatches.length} order matches after simulation.`
      );

      const txnData = await this._generateTxn(
        nonConflictingMatches,
        targetBaseFeeGwei,
        targetPriorityFeeGwei,
        job.data.currentBlockTimestamp
      );

      if (!txnData) {
        logger.log('execution-engine', `Block ${job.data.targetBlockNumber}. No matches found`);
        return;
      }

      const { receipt, txn } = await this._broadcaster.broadcast(txnData);

      if (receipt.status === 1) {
        const gasUsage = receipt.gasUsed.toString();
        await this._savePendingMatches(nonConflictingMatches.map((item) => item.match));
        logger.log(
          'execution-engine',
          `Block ${job.data.targetBlockNumber}. Txn ${txn.hash} executed successfully. Gas used: ${gasUsage}`
        );
      } else {
        logger.log('execution-engine', `Block ${job.data.targetBlockNumber}. Txn ${txn.hash} execution failed`);
      }
    } catch (err) {
      logger.error('execution-engine', `failed to process job for block ${job.data.targetBlockNumber} ${err}`);
    }
  }

  protected async simulate(
    matches: (NativeMatch | NonNativeMatch)[],
    targetBlock: {
      timestamp: number;
      blockNumber: number;
      gasPrice: ethers.BigNumberish;
    },
    currentBlock: {
      timestamp: number;
      blockNumber: number;
      gasPrice: ethers.BigNumberish;
    }
  ) {
    const results: {
      match: NativeMatch | NonNativeMatch;
      verificationResult:
        | ValidityResult<{ native: NativeMatchExecutionInfo }>
        | ValidityResult<{ native: NativeMatchExecutionInfo; nonNative: NonNativeMatchExecutionInfo }>;
    }[] = await Promise.all(
      matches.map(async (match) => {
        try {
          const res = await match.verifyMatchAtTarget(targetBlock, currentBlock.timestamp);
          return { match, verificationResult: res };
        } catch (err) {
          return {
            match,
            verificationResult: { isValid: false, reason: err instanceof Error ? err.message : `${err}` } as Invalid
          };
        }
      })
    );

    const nonNativeTransfers: Transfer[] = [];
    const nativeTransfers: Transfer[] = [];

    for (const result of results) {
      if (result.verificationResult.isValid) {
        const data = result.verificationResult.data;
        if ('nonNative' in data) {
          nonNativeTransfers.push(...data.nonNative.nonNativeExecutionTransfers);
        }
        nativeTransfers.push(...data.native.nativeExecutionTransfers);
      }
    }

    const initialState = await this._loadInitialState(
      [...nonNativeTransfers, ...nativeTransfers],
      currentBlock.blockNumber
    );

    return this._simulate(initialState, results).map((item) => item.match);
  }

  protected _simulate(
    initialState: ExecutionState,
    matches: {
      match: NativeMatch | NonNativeMatch;
      verificationResult:
        | ValidityResult<{ native: NativeMatchExecutionInfo }>
        | ValidityResult<{ native: NativeMatchExecutionInfo; nonNative: NonNativeMatchExecutionInfo }>;
    }[]
  ) {
    const simulationMatches = matches.map(({ match, verificationResult }) => {
      return {
        match,
        verificationResult,
        isExecutable: verificationResult.isValid
      };
    });

    const simulator = new OrderExecutionSimulator(initialState);

    const applyNonNativeMatches = () => {
      simulator.reset();
      for (const item of simulationMatches) {
        if (item.isExecutable && item.verificationResult.isValid && 'nonNative' in item.verificationResult.data) {
          const res = simulator.simulateMatch(item.verificationResult.data.nonNative);
          if (!res.isValid) {
            item.isExecutable = false;
          }
        }
      }
    };

    const applyNativeMatches = () => {
      for (const item of simulationMatches) {
        if (item.isExecutable && item.verificationResult.isValid) {
          const res = simulator.simulateMatch(item.verificationResult.data.native);
          if (!res.isValid) {
            item.isExecutable = false;
            return { complete: false };
          }
        }
      }
      return { complete: true };
    };

    let complete = false;
    while (!complete) {
      applyNonNativeMatches();
      const res = applyNativeMatches();
      complete = res.complete;
    }

    const results = simulationMatches.filter((item) => item.isExecutable);

    return results;
  }

  protected async _loadInitialState(transfers: Transfer[], currentBlockNumber: number): Promise<ExecutionState> {
    const weth = Common.Addresses.Weth[parseInt(this._chainId, 10)];
    const initialState: ExecutionState = {
      erc721Balances: {},
      wethBalances: {
        contract: weth,
        balances: {},
        allowances: {}
      },
      ethBalances: {
        balances: {}
      },
      executedOrders: {},
      executedNonces: {}
    };

    const batchProvider = new ethers.providers.JsonRpcBatchProvider(this._rpcProvider.connection);
    const queue = new PQueue({ concurrency: 800 });
    const ids = new Set<string>();
    const wethContract = new ethers.Contract(weth, ERC20ABI, batchProvider);
    for (const transfer of transfers) {
      switch (transfer.kind) {
        case TransferKind.ERC721: {
          const id = `${TransferKind.ERC721}:${transfer.contract}:${transfer.tokenId}`;
          if (!ids.has(id)) {
            ids.add(id);
            queue
              .add(async () => {
                const contract = new ethers.Contract(transfer.contract, ERC721ABI, batchProvider);
                const owner = await contract.getOwner(transfer.tokenId, { blockTag: currentBlockNumber });
                initialState.erc721Balances[transfer.contract] = {
                  contract: transfer.contract,
                  balances: {
                    ...(initialState.erc721Balances[transfer.contract]?.balances ?? {}),
                    [transfer.tokenId]: {
                      owner: owner.toLowerCase(),
                      balance: 1
                    }
                  }
                };
              })
              .catch((err) => {
                logger.error('execution-engine', `failed to load initial state ${err}`);
              });
          }
          break;
        }
        case TransferKind.WETH: {
          const balanceId = `${TransferKind.WETH}:balance:${transfer.from}`;
          if (!ids.has(balanceId)) {
            queue
              .add(async () => {
                const wethBalance = (await wethContract.getBalance(transfer.from, {
                  blockTag: currentBlockNumber
                })) as BigNumberish;
                initialState.wethBalances.balances[transfer.from] = {
                  balance: wethBalance.toString()
                };
              })
              .catch((err) => {
                logger.error('execution-engine', `failed to load initial state ${err}`);
              });
          }
          const allowanceId = `${TransferKind.WETH}:allowance:${transfer.from}:${transfer.operator}`;
          if (!ids.has(allowanceId)) {
            queue
              .add(async () => {
                const allowance = (await wethContract.getAllowance(transfer.from, transfer.operator, {
                  blockTag: currentBlockNumber
                })) as BigNumberish;
                initialState.wethBalances.allowances[transfer.from] = {
                  ...(initialState.wethBalances.allowances[transfer.from] ?? {}),
                  [transfer.operator]: allowance.toString()
                };
              })
              .catch((err) => {
                logger.error('execution-engine', `failed to load initial state ${err}`);
              });
          }
          break;
        }
        case TransferKind.ETH: {
          const id = `${TransferKind.ETH}:balance:${transfer.from}`;
          if (!ids.has(id)) {
            queue
              .add(async () => {
                const balance = (await batchProvider.getBalance(transfer.from, currentBlockNumber)) as BigNumberish;
                initialState.ethBalances.balances[transfer.from] = {
                  balance: balance.toString()
                };
              })
              .catch((err) => {
                logger.error('execution-engine', `failed to load initial state ${err}`);
              });
          }
          break;
        }
      }
    }
    await queue.onIdle();
    return initialState;
  }

  protected async _generateTxn(
    matches: (NativeMatch | NonNativeMatch)[],
    baseFeeGwei: number,
    priorityFeeGwei: number,
    currentBlockTimestamp: number
  ) {
    if (matches.length === 0) {
      return null;
    }

    const baseFeeWei = parseUnits(baseFeeGwei.toString(), 'gwei');
    const priorityFeeWei = parseUnits(priorityFeeGwei.toString(), 'gwei');
    const maxFeePerGas = baseFeeWei.add(priorityFeeWei);

    const nonNativeMatches = matches.filter((item) => !item.isNative) as NonNativeMatch[];

    const matchOrders: MatchOrders[] = await Promise.all(
      matches.map((item) => item.getMatchOrders(currentBlockTimestamp))
    );
    if (nonNativeMatches.length > 0) {
      const matchExternalFulfillments = await Promise.all(
        nonNativeMatches.map((item) => item.getExternalFulfillment(this._matchExecutor.address))
      );
      const externalFulfillments: ExternalFulfillments = {
        calls: matchExternalFulfillments.map((item) => item.call),
        nftsToTransfer: matchExternalFulfillments.flatMap((item) => item.nftsToTransfer)
      };

      const batch: Batch = {
        externalFulfillments,
        matches: matchOrders
      };
      const txn = this._matchExecutor.getBrokerTxn(batch, maxFeePerGas, priorityFeeWei, 30_000_000);

      return txn;
    } else {
      const txn = this._matchExecutor.getNativeTxn(matchOrders, maxFeePerGas, priorityFeeWei, 30_000_000);

      return txn;
    }
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

      const block = await this._rpcProvider.getBlock(blockNumber);

      try {
        const currentGasPrice = await this._rpcProvider.getGasPrice();
        const currentGasPriceGwei = parseFloat(ethers.utils.formatUnits(currentGasPrice, 'gwei'));
        const job: ExecutionEngineJob = {
          id: `${config.env.chainId}:${blockNumber}`,
          currentBlockNumber: blockNumber,
          currentGasPriceWei: currentGasPrice.toString(),
          currentGasPriceGwei,
          currentBlockTimestamp: block.timestamp,
          targetBlockNumber: blockNumber + this._blockOffset,
          targetBlockTimestamp: block.timestamp + this._blockOffset * 15 // TODO this should be configured based on the chain
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
