import { Job, MetricsTime, Queue, Worker } from 'bullmq';
import EventEmitter from 'events';
import Redis from 'ioredis';

import { logger } from '@/common/logger';

import { ProcessOptions, WithTiming } from './types';

export abstract class AbstractProcess<T extends { id: string }, U> extends EventEmitter {
  protected _worker: Worker<T, WithTiming<U>>;
  protected _queue: Queue<T, WithTiming<U>>;

  constructor(protected _db: Redis, protected queueName: string, options?: ProcessOptions) {
    super();
    const metrics =
      options?.enableMetrics === true
        ? {
            maxDataPoints: MetricsTime.ONE_WEEK
          }
        : options?.enableMetrics;

    this._queue = new Queue(this.queueName, {
      connection: this._db.duplicate(),
      defaultJobOptions: {
        attempts: options?.attempts ?? 5,
        backoff: {
          type: 'exponential',
          delay: 10_000
        },
        removeOnComplete: true,
        removeOnFail: 10_000
      }
    });

    this._worker = new Worker<T, WithTiming<U>>(this.queueName, this._processJob.bind(this), {
      connection: this._db.duplicate(),
      concurrency: options?.concurrency ?? 1,
      autorun: false,
      metrics: metrics || undefined
    });

    this._registerListeners(options?.debug);
  }

  abstract processJob(job: Job<T, U>): Promise<U>;
  abstract add(jobs: T | T[]): Promise<void>;

  public async run() {
    await this._run();
  }

  public resume() {
    this._resume();
  }

  public async pause() {
    await this._pause();
  }

  protected async _run() {
    if (!this._worker.isRunning()) {
      await this._worker.run();
    }
  }

  protected _resume() {
    if (this._worker.isPaused()) {
      this._worker.resume();
    }
  }

  protected async _pause() {
    if (!this._worker.isPaused()) {
      return await this._worker.pause();
    }
  }

  protected async _processJob(job: Job<T, WithTiming<U>>): Promise<WithTiming<U>> {
    const start = Date.now();
    const result = await this.processJob(job);
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

  protected _registerListeners(verbose = false): void {
    this._registerWorkerListeners(verbose);
  }

  protected _registerWorkerListeners(verbose = false) {
    this._worker.on('error', (err) => {
      logger.error(this.queueName, err.message);
    });
    const queueName = this.queueName.padEnd(20, ' ');

    if (verbose) {
      this._worker.on('active', (job) => {
        logger.info(this.queueName, `${queueName} job ${job.id} - activated`);
      });
      this._worker.on('progress', (job) => {
        logger.info(this.queueName, `${queueName} job ${job.id} - progress ${job.progress}`);
      });
      this._worker.on('completed', (job, result) => {
        logger.info(
          this.queueName,
          `${queueName} job ${job.id} - completed. Process Duration: ${
            result.timing.completed - result.timing.started
          }ms Lifecycle Duration: ${result.timing.completed - result.timing.created}ms`
        );
      });
      this._worker.on('failed', (job, err) => {
        logger.warn(this.queueName, `${queueName} job ${job?.data.id} - failed ${err.message}`);
      });

      this._worker.on('stalled', (jobId) => {
        logger.info(this.queueName, `${queueName} job: ${jobId} - stalled`);
      });

      this._worker.on('closing', () => {
        logger.info(this.queueName, `${queueName} worker - closing`);
      });
      this._worker.on('closed', () => {
        logger.info(this.queueName, `${queueName} worker - closed`);
      });

      this._worker.on('drained', () => {
        logger.info(this.queueName, `${queueName} worker - drained`);
      });

      this._worker.on('ioredis:close', () => {
        logger.info(this.queueName, `${queueName} ioredis - closed`);
      });

      this._worker.on('paused', () => {
        logger.info(this.queueName, `${queueName} worker - paused`);
      });

      this._worker.on('ready', () => {
        logger.info(this.queueName, `${queueName} worker - ready`);
      });

      this._worker.on('resumed', () => {
        logger.info(this.queueName, `${queueName} worker - resumed`);
      });
    }
  }
}
