import { Job, MetricsTime, Queue, Worker } from 'bullmq';
import EventEmitter from 'events';
import Redis from 'ioredis';

import { logger } from '@/common/logger';

import { ProcessOptions, WithTiming } from './types';

export abstract class AbstractProcess<T extends { id: string }, U> extends EventEmitter {
  protected _worker: Worker<T, WithTiming<U>>;
  protected _queue: Queue<T, WithTiming<U>>;

  public get queue() {
    return this._queue;
  }

  log(message: string) {
    logger.log(this.queueName, message);
  }
  error(message: string) {
    logger.error(this.queueName, message);
  }
  warn(message: string) {
    logger.warn(this.queueName, message);
  }

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
        removeOnFail: 10_000,
        delay: options?.delay ?? 0
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

  public async run(): Promise<void> {
    await this._run();
  }

  public resume() {
    this._resume();
  }

  public async pause() {
    await this._pause();
  }

  public async close() {
    await this._close();
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

  protected async _close() {
    if (this._worker.isPaused() || this._worker.isRunning()) {
      const queuePromise = this._queue.close();
      const workerPromise = this._worker.close();
      return await Promise.all([queuePromise, workerPromise]);
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
    this._registerProcessListeners();
  }

  protected _registerProcessListeners() {
    process.setMaxListeners(process.listenerCount('SIGINT') + 1);
    process.once('SIGINT', async () => {
      try {
        await this.close();
        this.log(`Gracefully closed`);
      } catch (err) {
        this.error(`Error closing process: ${JSON.stringify(err)}`);
      }
    });
  }

  protected _registerWorkerListeners(verbose = false) {
    this._worker.on('error', (err) => {
      this.error(err.message);
    });
    if (verbose) {
      this._worker.on('active', (job) => {
        this.log(`job ${job.id} - activated`);
      });
      this._worker.on('progress', (job) => {
        this.log(`job ${job.id} - progress ${job.progress}`);
      });
      this._worker.on('completed', (job, result) => {
        this.log(
          `job ${job.id} - completed. Process Duration: ${
            result.timing.completed - result.timing.started
          }ms Lifecycle Duration: ${result.timing.completed - result.timing.created}ms`
        );
      });
      this._worker.on('failed', (job, err) => {
        this.warn(`job ${job?.data.id} - failed ${err.message}`);
      });

      this._worker.on('stalled', (jobId) => {
        this.log(`job: ${jobId} - stalled`);
      });

      this._worker.on('closing', () => {
        this.log(`worker - closing`);
      });
      this._worker.on('closed', () => {
        this.log(`worker - closed`);
      });

      this._worker.on('drained', () => {
        this.log(`worker - drained`);
      });

      this._worker.on('ioredis:close', () => {
        this.log(`ioredis - closed`);
      });

      this._worker.on('paused', () => {
        this.log(`worker - paused`);
      });

      this._worker.on('ready', () => {
        this.log(`worker - ready`);
      });

      this._worker.on('resumed', () => {
        this.log(`worker - resumed`);
      });
    }
  }
}
