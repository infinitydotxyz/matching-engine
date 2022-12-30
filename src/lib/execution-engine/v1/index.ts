import { BulkJobOptions, Job } from 'bullmq';
import { ethers } from 'ethers';
import Redis from 'ioredis';
import Redlock, { ExecutionError, RedlockAbortSignal } from 'redlock';

import { logger } from '@/common/logger';
import { config } from '@/config';
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
    logger.log(
      'execution-engine',
      `Generating txn for target: ${job.data.targetBlockNumber}. Current Gas Price: ${job.data.currentGasPriceGwei} gwei`
    );

    await Promise.resolve();
    return;
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
