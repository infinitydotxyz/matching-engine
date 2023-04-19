import { Job } from 'bullmq';
import { ethers } from 'ethers';
import { Redis } from 'ioredis';
import { ExecutionError } from 'redlock';

import { FlashbotsBundleProvider } from '@flashbots/ethers-provider-bundle';
import { ChainId } from '@infinityxyz/lib/types/core';
import { ONE_MIN, sleep } from '@infinityxyz/lib/utils';

import { Block } from '@/common/block';
import { redlock } from '@/common/redis';
import { config } from '@/config';
import { AbstractProcess } from '@/lib/process/process.abstract';
import { ProcessOptions } from '@/lib/process/types';

import { safeWebSocketSubscription } from '../utils/safe-websocket-subscription';

interface JobData {
  id: string;
}

interface JobResult {
  id: string;
}

export class BlockScheduler extends AbstractProcess<JobData, JobResult> {
  constructor(
    db: Redis,
    chainId: ChainId,
    protected _blockProcessors: AbstractProcess<{ id: string; currentBlock: Block; targetBlock: Block }, unknown>[],
    protected _wsProvider: ethers.providers.WebSocketProvider,
    protected _httpProvider: ethers.providers.StaticJsonRpcProvider,
    options?: ProcessOptions
  ) {
    super(db, `block-scheduler:chain:${chainId}`, options);
  }

  async run(): Promise<void> {
    try {
      await this.queue.add(
        'block-scheduler',
        {
          id: config.env.chainId,
          _processMetadata: {
            type: 'default'
          }
        },
        {
          jobId: `${config.env.chainId}`,
          repeat: {
            every: 1000 * 60,
            immediately: true
          },
          removeOnComplete: false
        }
      );
    } catch (err) {
      this.warn(`Failed to start repeatable job ${JSON.stringify(err, null, 2)}`);
    }
    await this._run();
  }

  public async close() {
    await this._close();
  }

  async processJob(job: Job<JobData, JobResult, string>): Promise<JobResult> {
    const lockKey = `block-scheduler:chain:${config.env.chainId}:lock`;
    const lockDuration = 15_000;

    if (job.timestamp < Date.now() - 5 * ONE_MIN) {
      return {
        id: job.data.id
      };
    }

    let cancel: undefined | (() => void);
    const handler = (signal: AbortSignal) => async (blockNumber: number) => {
      this.log(`Received block ${blockNumber}`);

      if (signal.aborted) {
        cancel?.();
        return;
      }

      const block = await this._httpProvider.getBlock(blockNumber);
      const baseFeePerGas = block.baseFeePerGas;
      if (baseFeePerGas == null) {
        throw new Error(`Block ${blockNumber} does not have baseFeePerGas`);
      }
      const job = {
        id: `${config.env.chainId}:${blockNumber}`,
        currentBlock: {
          number: blockNumber,
          timestamp: block.timestamp,
          baseFeePerGas: baseFeePerGas.toString()
        },
        targetBlock: {
          number: blockNumber + config.broadcasting.blockOffset,
          timestamp: block.timestamp + config.broadcasting.blockOffset * 13, // TODO this should be configured based on the chain
          baseFeePerGas: FlashbotsBundleProvider.getMaxBaseFeeInFutureBlock(
            baseFeePerGas,
            config.broadcasting.blockOffset
          ).toString()
        }
      };

      for (const blockProcessor of this._blockProcessors) {
        await blockProcessor.add(job, job.id);
      }
    };

    try {
      await redlock.using([lockKey], lockDuration, async (signal) => {
        this.log(`Acquired lock!`);
        const callback = handler(signal);
        /**
         * use web sockets to attempt to get block numbers
         * right await
         */
        safeWebSocketSubscription(this._wsProvider.connection.url, async (provider) => {
          provider.on('block', callback);
          await Promise.resolve();
        });

        /**
         * poll in-case the websocket connection fails
         */
        const iterator = this._blockIterator(3_000);
        for await (const { blockNumber } of iterator) {
          await callback(blockNumber);
          if (signal.aborted) {
            return;
          }
        }
      });
    } catch (err) {
      if (err instanceof ExecutionError) {
        this.warn(`Failed to acquire lock`);
        await sleep(3000);
      } else if (err instanceof Error) {
        this.error(`${err}`);
        return {
          id: job.data.id
        };
      } else {
        this.error(`Unknown error: ${err}`);
        return {
          id: job.data.id
        };
      }
    }
    return {
      id: job.data.id
    };
  }

  protected async *_blockIterator(delay: number) {
    while (true) {
      const blockNumber = await this._httpProvider.getBlockNumber();
      yield { blockNumber };
      await sleep(delay);
    }
  }
}
