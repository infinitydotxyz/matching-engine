import { Job, MetricsTime, Queue, Worker } from 'bullmq';
import Redis from 'ioredis';

import { ChainId } from '@infinityxyz/lib/types/core';

import { logger } from '@/common/logger';

import { MatchingEngineOptions, WithTiming } from './types';

export abstract class AbstractMatchingEngine<T extends { id: string }, U> {
  protected _worker: Worker<T, WithTiming<U>>;
  protected _queue: Queue<T, WithTiming<U>>;

  constructor(
    protected _db: Redis,
    protected _chainId: ChainId,
    protected queueName: string,
    options?: MatchingEngineOptions
  ) {
    const metrics =
      options?.enableMetrics === true
        ? {
            maxDataPoints: MetricsTime.ONE_WEEK
          }
        : options?.enableMetrics;

    this._queue = new Queue(this.queueName, {
      connection: this._db.duplicate(),
      defaultJobOptions: {
        attempts: 5,
        backoff: {
          type: 'exponential',
          delay: 10_000
        },
        removeOnComplete: true,
        removeOnFail: 10_000
      }
    });

    this._worker = new Worker<T, WithTiming<U>>(this.queueName, this._processOrder.bind(this), {
      connection: this._db.duplicate(),
      concurrency: options?.concurrency ?? 1,
      autorun: false,
      metrics: metrics || undefined
    });

    this._registerListeners(options?.debug);
  }

  abstract processOrder(job: Job<T, U>): Promise<U>;
  abstract add(jobs: T | T[]): Promise<void>;

  public async run() {
    if (!this._worker.isRunning()) {
      await this._worker.run();
    }
  }

  public resume() {
    if (this._worker.isPaused()) {
      this._worker.resume();
    }
  }

  public async pause() {
    if (!this._worker.isPaused()) {
      return await this._worker.pause();
    }
  }

  protected async _processOrder(job: Job<T, WithTiming<U>>): Promise<WithTiming<U>> {
    const start = Date.now();
    const result = await this.processOrder(job);
    const end = Date.now();

    return {
      ...result,
      timing: {
        created: job.timestamp,
        started: start,
        completed: end
      }
    };
  }

  protected _registerListeners(verbose = false) {
    this._worker.on('error', (err) => {
      logger.error(this.queueName, err.message);
    });

    if (verbose) {
      this._worker.on('active', (job) => {
        logger.info(this.queueName, `job ${job.id} - activated`);
      });
      this._worker.on('progress', (job) => {
        logger.info(this.queueName, `job ${job.id} - progress ${job.progress}`);
      });
      this._worker.on('completed', (job, result) => {
        logger.info(
          this.queueName,
          `job ${job.id} - completed. Matching Duration: ${
            result.timing.completed - result.timing.started
          }ms Lifecycle Duration: ${result.timing.completed - result.timing.created}ms`
        );
      });
      this._worker.on('failed', (job, err) => {
        logger.warn(this.queueName, `job ${job?.data.id} - failed ${err.message}`);
      });

      this._worker.on('stalled', (jobId) => {
        logger.info(this.queueName, `job: ${jobId} - stalled`);
      });

      this._worker.on('closing', () => {
        logger.info(this.queueName, 'worker - closing');
      });
      this._worker.on('closed', () => {
        logger.info(this.queueName, 'worker - closed');
      });

      this._worker.on('drained', () => {
        logger.info(this.queueName, 'worker - drained');
      });

      this._worker.on('ioredis:close', () => {
        logger.info(this.queueName, 'ioredis - closed');
      });

      this._worker.on('paused', () => {
        logger.info(this.queueName, 'worker - paused');
      });

      this._worker.on('ready', () => {
        logger.info(this.queueName, 'worker - ready');
      });

      this._worker.on('resumed', () => {
        logger.info(this.queueName, 'worker - resumed');
      });
    }
  }
}
