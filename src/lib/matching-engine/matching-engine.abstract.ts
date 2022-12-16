import { Job, MetricsTime, Queue, Worker } from 'bullmq';
import Redis from 'ioredis';

import { ChainId } from '@infinityxyz/lib/types/core';

import { logger } from '@/common/logger';

import { JobData, MatchingEngineOptions } from './types';

export abstract class AbstractMatchingEngine<T extends { id: string }, JobResult> {
  protected _worker: Worker<JobData<T>, JobResult>;
  protected _queue: Queue<JobData<T>, JobResult>;

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

    this._worker = new Worker<JobData<T>, JobResult>(this.queueName, this.processOrder.bind(this), {
      connection: this._db.duplicate(),
      concurrency: options?.concurrency ?? 1,
      autorun: false,
      metrics: metrics || undefined
    });

    this._registerListeners(options?.debug);
  }

  abstract processOrder(job: Job<T, JobResult>): Promise<JobResult>;
  abstract add(job: T): Promise<void>;

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

  protected async _processOrder(job: Job<JobData<T>, JobResult>): Promise<JobResult> {
    const start = Date.now();
    const data = job.data;
    const result = await this.processOrder(job);
    const end = Date.now();

    job.data = {
      ...data,
      timing: {
        created: job.timestamp,
        started: start,
        completed: end
      }
    };

    return result;
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
      this._worker.on('completed', (job) => {
        logger.info(
          this.queueName,
          `job ${job.id} - completed. Matching Duration: ${
            job.data.timing.completed - job.data.timing.started
          }ms Lifecycle Duration: ${job.data.timing.completed - job.data.timing.created}ms`
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
