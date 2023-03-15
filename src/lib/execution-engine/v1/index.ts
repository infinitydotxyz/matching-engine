import { BulkJobOptions, Job } from 'bullmq';
import { BigNumber, BigNumberish, ethers } from 'ethers';
import { formatEther, formatUnits } from 'ethers/lib/utils';
import Redis from 'ioredis';
import PQueue from 'p-queue';
import Redlock, { RedlockAbortSignal } from 'redlock';

import { getCallTrace, parseCallTrace } from '@georgeroman/evm-tx-simulator';
import { ERC20ABI, ERC721ABI } from '@infinityxyz/lib/abi';
import { ChainId, ChainNFTs } from '@infinityxyz/lib/types/core';
import { ONE_MIN } from '@infinityxyz/lib/utils';
import { Common } from '@reservoir0x/sdk';

import {
  Block,
  BlockWithGas,
  BlockWithMaxFeePerGas,
  ExecutedBlock,
  NotIncludedBlock,
  PendingExecutionBlock,
  SkippedExecutionBlock
} from '@/common/block';
import {
  ExecutedExecutionOrder,
  InexecutableExecutionOrder,
  NotIncludedExecutionOrder,
  PendingExecutionOrder
} from '@/common/execution-order';
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
import { Batch, Call, ExternalFulfillments, MatchOrders } from '@/lib/match-executor/types';
import { OrderbookStorage } from '@/lib/orderbook/v1';
import { AbstractProcess } from '@/lib/process/process.abstract';
import { JobDataType, ProcessOptions } from '@/lib/process/types';
import { Invalid, ValidWithData, ValidityResultWithData } from '@/lib/utils/validity-result';

import { InvalidMatchError } from '../errors';

export type ExecutionEngineJob = {
  id: string;
  currentBlock: Block;
  targetBlock: Block;
};

export type ExecutionEngineResult = unknown;

export class ExecutionEngine<T> extends AbstractProcess<ExecutionEngineJob, ExecutionEngineResult> {
  protected _version: string;

  protected _startTimestampSeconds: number;

  protected _maxAttempts = 3;

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
    /**
     * start processing jobs from the queue
     */
    const runPromise = super._run().catch((err: Error) => {
      logger.error('execution-engine', ` Execution engine - Unexpected error: ${err.message}`);
    });
    await runPromise;
  }

  async processJob(job: Job<ExecutionEngineJob, unknown, string>): Promise<unknown> {
    const target = job.data.targetBlock;
    const current = job.data.currentBlock;
    const initiatedAt = job.timestamp;
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
        this._matchExecutor.initiator,
        orderDurationSeconds
      );

      const queue = new PQueue({ concurrency: 10 });
      const initializedMatchResults = await Promise.all(
        this._sortMatches(nonPendingMatches).map(async (item) => {
          let match: NativeMatch | NonNativeMatch;
          if (item.isNative) {
            match = new NativeMatch(item, this._chainId, orderFactory);
          } else {
            match = new NonNativeMatch(
              item,
              this._chainId,
              orderFactory,
              this._rpcProvider,
              this._matchExecutor.address
            );
          }
          const matchValidity = await queue.add(async () => {
            return await match.prepare({ taker: this._matchExecutor.address });
          });
          if (matchValidity.isValid) {
            return {
              isValid: true,
              data: match
            };
          }
          return {
            isValid: false,
            reason: matchValidity.reason,
            isTransient: matchValidity.isTransient,
            data: match
          };
        })
      );

      const { initializedMatches, failedMatches } = initializedMatchResults.reduce(
        (acc, item) => {
          if (item.isValid) {
            acc.initializedMatches.push(item.data);
          } else {
            this.log(`Match ${item.data.id} is not valid - ${item.reason}`);
            acc.failedMatches.push(item.data);
          }
          return acc;
        },
        {
          initializedMatches: [] as (NativeMatch | NonNativeMatch)[],
          failedMatches: [] as (NativeMatch | NonNativeMatch)[]
        }
      );

      logger.log(
        'execution-engine',
        `Block ${target.number}. Found ${initializedMatches.length} order matches before simulation.`
      );

      if (failedMatches.length > 0) {
        logger.warn('execution-engine', `Block ${target.number}. Failed to prepare ${failedMatches.length} matches`);
      }

      const { executable, inexecutable } = await this.simulate(initializedMatches, targetWithGas, current);

      const txnMatches = executable.map((item) => item.match);

      this.log(`Block ${target.number}. Found ${txnMatches.length} order matches after simulation.`);
      this.log(`Block ${target.number}. Valid matches: ${txnMatches.map((item) => item.id)}`);

      const { txn: txnData } = await this._generateTxn(txnMatches, targetWithGas, current);

      if (!txnData) {
        this.log(`Block ${target.number}. No matches found`);
        await this.saveSkippedBlock(targetWithGas, inexecutable, initiatedAt, 'No matches found');
        return;
      }

      logger.log('execution-engine', `Block ${target.number}. Simulating balance changes`);
      const balanceSimulationResult = await this.simulateBalanceChanges(txnData);
      if (!balanceSimulationResult.isValid) {
        await this.detectInvalidMatches(txnMatches, targetWithGas, current);
        if (job.attemptsMade === this._maxAttempts) {
          await this.saveSkippedBlock(targetWithGas, inexecutable, initiatedAt, balanceSimulationResult.reason);
          throw new Error(balanceSimulationResult.reason);
        }
        throw new InvalidMatchError(`Received invalid match`);
      }

      this.savePendingBlock(targetWithGas, txnMatches, inexecutable, balanceSimulationResult, initiatedAt).catch(
        (err) => {
          logger.error('execution-engine', `Failed to save pending block: ${err.message}`);
        }
      );

      logger.log('execution-engine', `Block ${target.number}. Txn generated.`);

      const { receipt } = await this._broadcaster.broadcast(txnData, {
        targetBlock: targetWithGas,
        currentBlock: current,
        signer: this._matchExecutor.initiator
      });

      if (receipt.status === 1) {
        const gasUsage = receipt.gasUsed.toString();
        await this._savePendingMatches(txnMatches.map((item) => item.match));
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

      await this.saveBlockResult(
        targetWithGas,
        txnMatches,
        inexecutable,
        balanceSimulationResult,
        initiatedAt,
        receipt
      );
    } catch (err) {
      console.error(err);
      if (err instanceof InvalidMatchError) {
        // throw the error to trigger a retry
        throw err;
      }
      logger.error('execution-engine', `failed to process job for block ${target.number} ${err}`);
    }
  }

  async add(job: ExecutionEngineJob, id?: string): Promise<void>;
  async add(jobs: ExecutionEngineJob[]): Promise<void>;
  async add(job: ExecutionEngineJob | ExecutionEngineJob[], id?: string): Promise<void> {
    const arr = Array.isArray(job) ? job : [job];
    if (Array.isArray(job) && id) {
      throw new Error(`Can only specify an id for a single job`);
    }

    const jobs: {
      name: string;
      data: JobDataType<ExecutionEngineJob>;
      opts?: BulkJobOptions | undefined;
    }[] = arr.map((item) => {
      return {
        name: `${item.id}`,
        data: {
          _processMetadata: {
            type: 'default'
          },
          ...item
        },
        opts: {
          attempts: this._maxAttempts,
          backoff: 0
        }
      };
    });
    await this._queue.addBulk(jobs);
  }

  protected async detectInvalidMatches(
    txnMatches: (NativeMatch | NonNativeMatch)[],
    targetBlock: BlockWithGas,
    currentBlock: Block
  ) {
    const matches = [];
    for (const match of txnMatches) {
      matches.push(match);
      const { txn } = await this._generateTxn(matches, targetBlock, currentBlock);
      if (txn) {
        try {
          await this._rpcProvider.estimateGas(txn);
        } catch (err) {
          this.error(`Match ${match.id} is invalid!`);
          await this._savePendingMatches([match.match], 15);
          return;
        }
      }
    }
  }

  protected async saveSkippedBlock(
    block: BlockWithGas,
    inexecutableMatches: {
      match: NativeMatch | NonNativeMatch;
      verificationResult: Invalid;
    }[],
    initiatedAt: number,
    reason: string
  ) {
    const keyValuePairs: string[] = [];

    const skippedBlock: SkippedExecutionBlock = {
      ...block,
      numExecutableMatches: 0,
      numInexecutableMatches: inexecutableMatches.length,
      timing: {
        initiatedAt
      },
      status: 'skipped',
      reason: reason
    };

    const skippedBlockKey = this._storage.executionStorage.getBlockKey(block.number);
    keyValuePairs.push(skippedBlockKey, JSON.stringify(skippedBlock));

    const handledOrderIds = new Set<string>();

    /**
     * process inexecutable order statuses
     */
    for (const item of inexecutableMatches) {
      const ids = [item.match.match.listing.id, item.match.match.offer.id];
      for (const id of ids) {
        if (!handledOrderIds.has(id)) {
          handledOrderIds.add(id);
          const matchedOrderId = ids.find((item) => item !== id) ?? '';
          const inexecutableOrder: InexecutableExecutionOrder = {
            status: 'inexecutable',
            reason: item.verificationResult.reason,
            matchId: item.match.id,
            matchedOrderId: matchedOrderId,
            block,
            timing: {
              initiatedAt
            }
          };
          const orderKey = this._storage.executionStorage.getInexecutableOrderExecutionKey(id);
          keyValuePairs.push(orderKey, JSON.stringify(inexecutableOrder));
        }
      }
    }

    await this._db.mset(keyValuePairs);
  }

  protected async saveBlockResult(
    block: BlockWithGas,
    txnMatches: (NativeMatch | NonNativeMatch)[],
    inexecutableMatches: {
      match: NativeMatch | NonNativeMatch;
      verificationResult: Invalid;
    }[],
    balanceSimulationResult: ValidWithData<{
      totalBalanceDiff: string;
      ethBalanceDiff: string;
      wethBalanceDiff: string;
    }>,
    initiatedAt: number,
    receipt: ethers.providers.TransactionReceipt
  ): Promise<void> {
    // TODO export block data to firestore
    const keyValuePairs: string[] = [];

    const receiptReceivedAt = Date.now();

    const effectiveGasPrice = receipt.effectiveGasPrice.toString();
    const cumulativeGasUsed = receipt.cumulativeGasUsed.toString();
    const gasUsed = receipt.gasUsed.toString();
    const timing = {
      initiatedAt: initiatedAt,
      receiptReceivedAt
    };

    const handledOrderIds = new Set<string>();
    const executedOrders: string[] = [];

    if (receipt.status === 1) {
      /**
       * set the block status to executed
       */
      const blockData = await this._rpcProvider.getBlock(receipt.blockHash);
      const executedBlock: ExecutedBlock = {
        ...block,
        status: 'executed',
        effectiveGasPrice,
        cumulativeGasUsed,
        gasUsed,
        txHash: receipt.transactionHash,
        timing: {
          ...timing,
          blockTimestamp: blockData.timestamp
        },
        numExecutableMatches: txnMatches.length,
        numInexecutableMatches: inexecutableMatches.length,
        balanceChanges: {
          ...balanceSimulationResult.data
        }
      };
      const blockKey = this._storage.executionStorage.getBlockKey(block.number);
      keyValuePairs.push(blockKey, JSON.stringify(executedBlock));

      const pipeline = this._db.pipeline();
      let pipelineRequiresSave = false;
      for (const item of txnMatches) {
        const ids = [item.match.listing.id, item.match.offer.id];
        for (const id of ids) {
          if (!handledOrderIds.has(id)) {
            handledOrderIds.add(id);
            const matchedOrderId = ids.find((item) => item !== id);
            const executionDuration = blockData.timestamp * 1000 - initiatedAt;
            const executedOrder: ExecutedExecutionOrder = {
              block,
              matchedOrderId: matchedOrderId ?? '',
              matchId: item.id,
              status: 'executed',
              effectiveGasPrice,
              cumulativeGasUsed,
              gasUsed,
              txHash: receipt.transactionHash,
              timing: {
                initiatedAt,
                blockTimestamp: blockData.timestamp,
                receiptReceivedAt
              }
            };
            const orderKey = this._storage.executionStorage.getExecutedOrderExecutionKey(id);
            keyValuePairs.push(orderKey, JSON.stringify(executedOrder));
            executedOrders.push(id);
            const collection =
              item.match.listing.order.nfts[0]?.collection ?? item.match.offer.order.nfts[0]?.collection;
            if (collection) {
              this._storage.executionStorage.saveExecutionDuration(pipeline, collection, executionDuration);
              pipelineRequiresSave = true;
            }
          }
        }
      }
      if (pipelineRequiresSave) {
        await pipeline.exec();
      }
    } else {
      const executedBlock: NotIncludedBlock = {
        ...block,
        status: 'not-included',
        effectiveGasPrice,
        cumulativeGasUsed,
        gasUsed,
        txHash: receipt.transactionHash,
        timing,
        numExecutableMatches: txnMatches.length,
        numInexecutableMatches: inexecutableMatches.length,
        balanceChanges: {
          ...balanceSimulationResult.data
        }
      };
      const blockKey = this._storage.executionStorage.getBlockKey(block.number);
      keyValuePairs.push(blockKey, JSON.stringify(executedBlock));

      for (const item of txnMatches) {
        const ids = [item.match.listing.id, item.match.offer.id];
        for (const id of ids) {
          if (!handledOrderIds.has(id)) {
            handledOrderIds.add(id);
            const matchedOrderId = ids.find((item) => item !== id);
            const notIncludedOrder: NotIncludedExecutionOrder = {
              block,
              matchedOrderId: matchedOrderId ?? '',
              matchId: item.id,
              status: 'not-included',
              effectiveGasPrice,
              cumulativeGasUsed,
              gasUsed,
              timing: {
                initiatedAt,
                receiptReceivedAt
              }
            };
            const orderKey = this._storage.executionStorage.getNotIncludedOrderExecutionKey(id);
            keyValuePairs.push(orderKey, JSON.stringify(notIncludedOrder));
          }
        }
      }
    }
    await this._db.mset(keyValuePairs);
    if (executedOrders.length > 0 && !this._broadcaster.isForked) {
      await this._storage.executionStorage.saveExecutedOrders(executedOrders);
    }
    await this._cleanup();
  }

  protected async _cleanup() {
    try {
      await this._db.zremrangebyscore(this._storage.executedOrdersOrderedSetKey, 0, Date.now());
    } catch (err) {
      this.warn(`Cleanup failed ${err}`);
    }
  }

  protected async savePendingBlock(
    block: BlockWithGas,
    txnMatches: (NativeMatch | NonNativeMatch)[],
    inexecutableMatches: {
      match: NativeMatch | NonNativeMatch;
      verificationResult: Invalid;
    }[],
    balanceSimulationResult: ValidWithData<{
      totalBalanceDiff: string;
      ethBalanceDiff: string;
      wethBalanceDiff: string;
    }>,
    initiatedAt: number
  ): Promise<void> {
    const keyValuePairs: string[] = [];

    /**
     * set the block status to pending
     */
    const pendingBlock: PendingExecutionBlock = {
      ...block,
      status: 'pending',
      timing: {
        initiatedAt
      },
      balanceChanges: {
        ...balanceSimulationResult.data
      },
      numExecutableMatches: txnMatches.length,
      numInexecutableMatches: inexecutableMatches.length
    };
    const blockKey = this._storage.executionStorage.getBlockKey(block.number);
    keyValuePairs.push(blockKey, JSON.stringify(pendingBlock));

    /**
     * only save a status event for each order once
     */
    const handledOrderIds = new Set<string>();

    /**
     * process executable order statuses first
     * so they get saved instead of any inexecutable conflicts
     */
    for (const item of txnMatches) {
      const ids = [item.match.listing.id, item.match.offer.id];
      for (const id of ids) {
        if (!handledOrderIds.has(id)) {
          handledOrderIds.add(id);
          const matchedOrderId = ids.find((item) => item !== id) ?? '';
          const pendingOrder: PendingExecutionOrder = {
            status: 'pending',
            matchId: item.match.matchId,
            matchedOrderId: matchedOrderId,
            block,
            timing: {
              initiatedAt
            }
          };
          const orderKey = this._storage.executionStorage.getPendingOrderExecutionKey(id);
          keyValuePairs.push(orderKey, JSON.stringify(pendingOrder));
        }
      }
    }

    /**
     * process inexecutable order statuses
     */
    for (const item of inexecutableMatches) {
      const ids = [item.match.match.listing.id, item.match.match.offer.id];
      for (const id of ids) {
        if (!handledOrderIds.has(id)) {
          handledOrderIds.add(id);
          const matchedOrderId = ids.find((item) => item !== id) ?? '';
          const inexecutableOrder: InexecutableExecutionOrder = {
            status: 'inexecutable',
            reason: item.verificationResult.reason,
            matchId: item.match.id,
            matchedOrderId: matchedOrderId,
            block,
            timing: {
              initiatedAt
            }
          };
          const orderKey = this._storage.executionStorage.getInexecutableOrderExecutionKey(id);
          keyValuePairs.push(orderKey, JSON.stringify(inexecutableOrder));
        }
      }
    }
    await this._db.mset(keyValuePairs);
  }

  protected async simulateBalanceChanges(txData: {
    from: string;
    to: string;
    maxFeePerGas: string;
    maxPriorityFeePerGas: string;
    gasLimit: string;
    data: string;
  }): Promise<ValidityResultWithData<{ totalBalanceDiff: string; ethBalanceDiff: string; wethBalanceDiff: string }>> {
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
        this._rpcProvider,
        {
          skipReverts: true
        }
      );

      if ('error' in trace && trace.error) {
        const error = trace.error;
        console.log(`Error while simulating balance changes`);
        console.log(error);

        try {
          await this._rpcProvider.estimateGas({
            ...txData
          });
        } catch (err) {
          this.warn(`Failed to simulate balance changes: ${(error as any).reason}`);
        }
        return {
          isValid: false,
          reason: 'transaction reverted',
          isTransient: false
        };
      }

      const finalState = parseCallTrace(trace);

      const ethBalanceDiff = BigNumber.from(
        finalState[matchExecutor]?.tokenBalanceState?.['native:0x0000000000000000000000000000000000000000'] ?? '0'
      );
      const wethBalanceDiff = BigNumber.from(finalState[matchExecutor]?.tokenBalanceState?.[`erc20:${weth}`] ?? '0');
      const totalBalanceDiff = ethBalanceDiff.add(wethBalanceDiff);

      if (totalBalanceDiff.gte(0)) {
        logger.log('execution-engine', `Match executor received ${formatEther(totalBalanceDiff.toString())} ETH/WETH`);
        return {
          data: {
            totalBalanceDiff: totalBalanceDiff.toString(),
            ethBalanceDiff: ethBalanceDiff.toString(),
            wethBalanceDiff: wethBalanceDiff.toString()
          },
          isValid: true
        };
      }

      logger.warn(
        'execution-engine',
        `Match executor lost ${formatEther(totalBalanceDiff.mul(-1).toString())} ETH/WETH. Tx ${JSON.stringify(txData)}`
      );
      return {
        isValid: false,
        reason: 'Match executor lost ETH/WETH',
        isTransient: true
      };
    }

    return {
      isValid: true,
      data: {
        totalBalanceDiff: BigNumber.from(0).toString(),
        ethBalanceDiff: BigNumber.from(0).toString(),
        wethBalanceDiff: BigNumber.from(0).toString()
      }
    };
  }

  protected async simulate(
    matches: (NativeMatch | NonNativeMatch)[],
    targetBlock: BlockWithMaxFeePerGas,
    currentBlock: Block
  ) {
    const results: {
      match: NativeMatch | NonNativeMatch;
      verificationResult:
        | ValidityResultWithData<{ native: NativeMatchExecutionInfo }>
        | ValidityResultWithData<{ native: NativeMatchExecutionInfo; nonNative: NonNativeMatchExecutionInfo }>;
    }[] = await Promise.all(
      matches.map(async (match) => {
        try {
          const res = await match.verifyMatchAtTarget(targetBlock, currentBlock);
          return { match, verificationResult: res };
        } catch (err) {
          logger.warn('execution-engine', `Failed to verify match ${match.id} ${err}`);
          return {
            match,
            verificationResult: {
              isValid: false,
              reason: err instanceof Error ? err.message : `${err}`,
              isTransient: true
            } as Invalid
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

    console.log(`Initial state: ${JSON.stringify(initialState, null, 2)}`);

    console.log(`Transfers`);
    console.log(JSON.stringify([...nonNativeTransfers, ...nativeTransfers], null, 2));
    return this._simulate(initialState, results);
  }

  protected _simulate(
    initialState: ExecutionState,
    matches: {
      match: NativeMatch | NonNativeMatch;
      verificationResult:
        | ValidityResultWithData<{ native: NativeMatchExecutionInfo }>
        | ValidityResultWithData<{ native: NativeMatchExecutionInfo; nonNative: NonNativeMatchExecutionInfo }>;
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
            item.verificationResult = res;
            logger.log('execution-engine', `Match ${item.match.id} is not executable Reason: ${res.reason}`);
          }
        }
      }
    };

    const applyNativeMatches = () => {
      for (const item of simulationMatches) {
        if (item.isExecutable && item.verificationResult.isValid) {
          const res = simulator.simulateMatch(item.verificationResult.data.native);
          if (!res.isValid) {
            logger.log('execution-engine', `Match ${item.match.id} is not executable Reason: ${res.reason}`);
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

    const executable = simulationMatches.filter((item) => item.isExecutable) as {
      match: NativeMatch | NonNativeMatch;
      verificationResult:
        | ValidWithData<{
            native: NativeMatchExecutionInfo;
          }>
        | ValidWithData<{
            native: NativeMatchExecutionInfo;
            nonNative: NonNativeMatchExecutionInfo;
          }>;
      isExecutable: true;
    }[];
    const inexecutable = simulationMatches.filter((item) => !item.isExecutable) as {
      match: NativeMatch | NonNativeMatch;
      verificationResult: Invalid;
      isExecutable: false;
    }[];

    return { executable, inexecutable };
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
      return { txn: null, isNative: false };
    }

    const nonNativeMatches = matches.filter((item) => !item.isNative) as NonNativeMatch[];

    const matchOrders: MatchOrders[] = await Promise.all(
      matches.map((item) => item.getMatchOrders(currentBlock.timestamp))
    );

    if (nonNativeMatches.length > 0) {
      const matchExternalFulfillmentResults = await Promise.all(
        nonNativeMatches.map((item) => item.getExternalFulfillment(this._matchExecutor.address))
      );

      const { valid, numInvalid } = matchExternalFulfillmentResults.reduce(
        (acc, item) => {
          if (item.isValid) {
            acc.valid.push(item.data);
            return acc;
          }
          acc.numInvalid += 1;
          this.warn(`Received invalid external fulfillment - ${item.reason}`);
          return acc;
        },
        { valid: [] as { call: Call; nftsToTransfer: ChainNFTs[] }[], numInvalid: 0 }
      );

      if (numInvalid > 0) {
        throw new Error(`Received ${numInvalid} invalid external fulfillment`);
      }

      // TODO generate fulfillments prior and filter out invalid items
      const externalFulfillments: ExternalFulfillments = {
        calls: valid.map((item) => item.call),
        nftsToTransfer: valid.flatMap((item) => item.nftsToTransfer)
      };

      const batch: Batch = {
        externalFulfillments,
        matches: matchOrders
      };

      console.log('batch', JSON.stringify(batch, null, 2));
      const txn = this._matchExecutor.getBrokerTxn(batch, targetBlock, 30_000_000);

      return { txn, isNative: false };
    } else {
      console.log('Native txn', JSON.stringify(matchOrders, null, 2));
      const txn = this._matchExecutor.getNativeTxn(matchOrders, targetBlock, 30_000_000);

      return { txn, isNative: true };
    }
  }

  protected _filterPendingOrders(matches: Match[], pendingOrders: Set<string>) {
    return matches.filter((match) => {
      return !pendingOrders.has(match.listing.id) && !pendingOrders.has(match.offer.id);
    });
  }

  protected async _savePendingMatches(matches: Match[], ttlMinutes = 5) {
    const pipeline = this._db.pipeline();
    const now = Date.now();
    const expiration = now + ONE_MIN * ttlMinutes;
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
      100
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

  protected _checkSignal(signal: RedlockAbortSignal) {
    if (signal.aborted) {
      throw signal.error;
    }
  }
}
