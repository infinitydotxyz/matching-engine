import { Job } from 'bullmq';
import { BigNumber, BigNumberish, ethers } from 'ethers';
import { formatEther, formatUnits } from 'ethers/lib/utils';
import Redis from 'ioredis';
import PQueue from 'p-queue';
import Redlock, { ExecutionError, RedlockAbortSignal } from 'redlock';

import { FlashbotsBundleProvider } from '@flashbots/ethers-provider-bundle';
import { getCallTrace, parseCallTrace } from '@georgeroman/evm-tx-simulator';
import { ERC20ABI, ERC721ABI } from '@infinityxyz/lib/abi';
import { ChainId } from '@infinityxyz/lib/types/core';
import { ONE_MIN } from '@infinityxyz/lib/utils';
import { Common } from '@reservoir0x/sdk';

import { Block, BlockWithGas, BlockWithMaxFeePerGas } from '@/common/block';
import { logger } from '@/common/logger';
import { config } from '@/config';
import { Broadcaster } from '@/lib/broadcaster/broadcaster.abstract';
import { MatchExecutor } from '@/lib/match-executor/match-executor';
import { NativeMatch } from '@/lib/match-executor/match/native-match';
import { NonNativeMatch } from '@/lib/match-executor/match/non-native-match';
import { Match, NativeMatchExecutionInfo, NonNativeMatchExecutionInfo } from '@/lib/match-executor/match/types';
import { OrderFactory } from '@/lib/match-executor/order/flow';
import { OrderExecutionSimulator } from '@/lib/match-executor/simulator/order-execution-simulator';
import { ExecutionState, Transfer, TransferKind } from '@/lib/match-executor/simulator/types';
import { Batch, ExternalFulfillments, MatchOrders } from '@/lib/match-executor/types';
import { OrderbookStorage } from '@/lib/orderbook/v1';
import { AbstractProcess } from '@/lib/process/process.abstract';
import { ProcessOptions } from '@/lib/process/types';
import { Invalid, ValidityResult } from '@/lib/utils/validity-result';

export type ExecutionEngineJob = {
  id: string;
  currentBlock: Block;
  targetBlock: Block;
};

export type ExecutionEngineResult = unknown;

export class ExecutionEngine<T> extends AbstractProcess<ExecutionEngineJob, ExecutionEngineResult> {
  protected _version: string;

  protected _startTimestampSeconds: number;

  constructor(
    protected _chainId: ChainId,
    protected _storage: OrderbookStorage,
    _db: Redis,
    protected _redlock: Redlock,
    protected _websocketProvider: ethers.providers.WebSocketProvider,
    protected _rpcProvider: ethers.providers.StaticJsonRpcProvider,
    protected _matchExecutor: MatchExecutor,
    protected _blockOffset: number,
    protected _broadcaster: Broadcaster<T>,
    options?: ProcessOptions
  ) {
    const version = 'v1';
    super(_db, `execution-engine:${version}`, { ...options, attempts: 1 });
    this._version = version;
    this._startTimestampSeconds = Math.floor(Date.now() / 1000);
  }

  public async run(): Promise<void> {
    const blockListenerLockKey = `execution-engine:chain:${config.env.chainId}:lock`;
    const lockDuration = 15_000;
    /**
     * start processing jobs from the queue
     */
    const runPromise = super._run().catch((err: Error) => {
      logger.error('execution-engine', ` Execution engine - Unexpected error: ${err.message}`);
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
    const target = job.data.targetBlock;
    const current = job.data.currentBlock;
    try {
      if (target.timestamp < this._startTimestampSeconds) {
        logger.warn(
          'block-listener',
          `Received block ${job.data.targetBlock.number} with timestamp ${job.data.targetBlock.timestamp} which is older than the start time ${this._startTimestampSeconds}. Skipping...`
        );
        return;
      }

      const priorityFeeWei = config.broadcasting.priorityFee;
      const targetBaseFeeWei = target.baseFeePerGas;
      const targetMaxFeePerGasWei = BigNumber.from(targetBaseFeeWei).add(priorityFeeWei);
      const targetMaxFeePerGasGwei = parseFloat(formatUnits(targetMaxFeePerGasWei, 'gwei'));

      const targetWithGas: BlockWithGas = {
        ...target,
        maxPriorityFeePerGas: priorityFeeWei.toString(),
        maxFeePerGas: targetMaxFeePerGasWei.toString()
      };

      logger.log(
        'execution-engine',
        `Generating txn for target: ${target.number}. Current base fee: ${formatUnits(
          current.baseFeePerGas,
          'gwei'
        )}. Target max fee per gas: ${targetMaxFeePerGasGwei} gwei`
      );

      const [matches, pendingOrders] = await Promise.all([
        this._loadMatches(targetMaxFeePerGasGwei),
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
        `Block ${target.number}. Found ${sortedMatches.length} order matches before simulation.`
      );

      const nonConflictingMatches = await this.simulate(sortedMatches, targetWithGas, current);

      logger.log(
        'execution-engine',
        `Block ${target.number}. Found ${nonConflictingMatches.length} order matches after simulation.`
      );

      logger.log(
        'execution-engine',
        `Block ${target.number}. Valid matches: ${nonConflictingMatches.map((item) => item.id)}`
      );

      const txnData = await this._generateTxn(nonConflictingMatches, targetWithGas, current);

      if (!txnData) {
        logger.log('execution-engine', `Block ${target.number}. No matches found`);
        return;
      }

      logger.log('execution-engine', `Block ${target.number}. Simulating balance changes`);
      await this.simulateBalanceChanges(txnData);

      logger.log('execution-engine', `Block ${target.number}. Txn generated.`);

      const { receipt } = await this._broadcaster.broadcast(txnData, {
        targetBlock: targetWithGas,
        currentBlock: current,
        signer: this._matchExecutor.owner
      });

      if (receipt.status === 1) {
        const gasUsage = receipt.gasUsed.toString();
        await this._savePendingMatches(nonConflictingMatches.map((item) => item.match));
        logger.log(
          'execution-engine',
          `Block ${target.number}. Txn ${receipt.transactionHash} executed successfully. Gas used: ${gasUsage}`
        );
      } else {
        logger.log('execution-engine', `Block ${target.number}. Txn ${receipt.transactionHash} execution failed`);
        logger.log(
          'execution-engine',
          `Block ${target.number}. Txn ${receipt.transactionHash} receipt: ${JSON.stringify(receipt, null, 2)}`
        );
      }
    } catch (err) {
      logger.error('execution-engine', `failed to process job for block ${target.number} ${err}`);
    }
  }

  protected async simulateBalanceChanges(txData: {
    from: string;
    to: string;
    maxFeePerGas: string;
    maxPriorityFeePerGas: string;
    gasLimit: string;
    data: string;
  }) {
    if (!config.env.isForkingEnabled) {
      const matchExecutor = this._matchExecutor.address;
      const weth = Common.Addresses.Weth[parseInt(this._chainId, 10)];

      const trace = await getCallTrace(
        {
          from: txData.from,
          to: txData.to,
          data: txData.data,
          value: '0',
          gas: txData.gasLimit,
          gasPrice: txData.maxFeePerGas
        },
        this._rpcProvider
      );

      const finalState = parseCallTrace(trace);

      const ethBalanceDiff = BigNumber.from(
        finalState[matchExecutor].tokenBalanceState['native:0x0000000000000000000000000000000000000000'] ?? '0'
      );
      const wethBalanceDiff = BigNumber.from(finalState[matchExecutor].tokenBalanceState[`erc20:${weth}`] ?? '0');
      const totalBalanceDiff = ethBalanceDiff.add(wethBalanceDiff);

      if (totalBalanceDiff.gte(0)) {
        logger.log('execution-engine', `Match executor received ${formatEther(totalBalanceDiff.toString())} ETH/WETH`);
        return;
      }

      logger.warn(
        'execution-engine',
        `Match executor lost ${formatEther(totalBalanceDiff.mul(-1).toString())} ETH/WETH. Tx ${JSON.stringify(txData)}`
      );
      throw new Error('Match executor lost ETH/WETH');
    }
  }

  protected async simulate(
    matches: (NativeMatch | NonNativeMatch)[],
    targetBlock: BlockWithMaxFeePerGas,
    currentBlock: Block
  ) {
    const results: {
      match: NativeMatch | NonNativeMatch;
      verificationResult:
        | ValidityResult<{ native: NativeMatchExecutionInfo }>
        | ValidityResult<{ native: NativeMatchExecutionInfo; nonNative: NonNativeMatchExecutionInfo }>;
    }[] = await Promise.all(
      matches.map(async (match) => {
        try {
          const res = await match.verifyMatchAtTarget(targetBlock, currentBlock);
          return { match, verificationResult: res };
        } catch (err) {
          logger.warn('execution-engine', `Failed to verify match ${match.id} ${err}`);
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

    const initialState = await this._loadInitialState([...nonNativeTransfers, ...nativeTransfers], currentBlock.number);

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
            logger.log('execution-engine', `Match ${item.match.id} is not executable Reason: ${res.error}`);
          }
        }
      }
    };

    const applyNativeMatches = () => {
      for (const item of simulationMatches) {
        if (item.isExecutable && item.verificationResult.isValid) {
          const res = simulator.simulateMatch(item.verificationResult.data.native);
          if (!res.isValid) {
            logger.log('execution-engine', `Match ${item.match.id} is not executable Reason: ${res.error}`);
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
                const owner = await contract.ownerOf(transfer.tokenId, { blockTag: currentBlockNumber });
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
                const wethBalance = (await wethContract.balanceOf(transfer.from, {
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
                const allowance = (await wethContract.allowance(transfer.from, transfer.operator, {
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
    targetBlock: BlockWithGas,
    currentBlock: Block
  ) {
    if (matches.length === 0) {
      return null;
    }

    const nonNativeMatches = matches.filter((item) => !item.isNative) as NonNativeMatch[];

    const matchOrders: MatchOrders[] = await Promise.all(
      matches.map((item) => item.getMatchOrders(currentBlock.timestamp))
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
      const txn = this._matchExecutor.getBrokerTxn(batch, targetBlock, 30_000_000);

      return txn;
    } else {
      const txn = this._matchExecutor.getNativeTxn(matchOrders, targetBlock, 30_000_000);

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
      10_000
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

  protected async _listen(signal: RedlockAbortSignal) {
    let cancel: (error: Error) => void = () => {
      return;
    };

    const handler = async (blockNumber: number) => {
      logger.log('block-listener', `Received block ${blockNumber} at ${new Date().toISOString()}`);

      try {
        this._checkSignal(signal);
      } catch (err) {
        if (err instanceof Error) {
          cancel(err);
        } else {
          const errorMessage = `Block listener. Unexpected error: ${err}`;
          cancel(new Error(errorMessage));
        }
        return;
      }

      try {
        const block = await this._rpcProvider.getBlock(blockNumber);
        const baseFeePerGas = block.baseFeePerGas;
        if (baseFeePerGas == null) {
          throw new Error(`Block ${blockNumber} does not have baseFeePerGas`);
        }

        const job: ExecutionEngineJob = {
          id: `${config.env.chainId}:${blockNumber}`,
          currentBlock: {
            number: blockNumber,
            timestamp: block.timestamp,
            baseFeePerGas: baseFeePerGas.toString()
          },
          targetBlock: {
            number: blockNumber + this._blockOffset,
            timestamp: block.timestamp + this._blockOffset * 13, // TODO this should be configured based on the chain
            baseFeePerGas: FlashbotsBundleProvider.getMaxBaseFeeInFutureBlock(
              baseFeePerGas,
              this._blockOffset
            ).toString()
          }
        };

        await this.add(job);
      } catch (err) {
        if (err instanceof Error) {
          logger.error('execution-engine', `Unexpected error while handling block: ${blockNumber} ${err.message}`);
        } else {
          logger.error('execution-engine', `Unexpected error while handling block: ${blockNumber} ${err}`);
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
