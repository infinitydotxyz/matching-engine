import { BulkJobOptions, Job, MetricsTime, Queue, QueueEvents, Worker } from 'bullmq';
import EventEmitter from 'events';
import Redis from 'ioredis';

import { logger } from '@/common/logger';

import { HealthInfo, JobDataType, ProcessJobResult, ProcessOptions, WithTiming } from './types';

export abstract class AbstractProcess<T extends { id: string }, U> extends EventEmitter {
  protected _worker: Worker<JobDataType<T>, WithTiming<U> | WithTiming<ProcessJobResult>>;
  protected _queue: Queue<JobDataType<T>, WithTiming<U> | WithTiming<ProcessJobResult>>;

  protected _cancelProcessListeners?: () => void;

  public get queue() {
    return this._queue;
  }

  public get worker() {
    return this._worker;
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

  protected _connections: Redis[];

  constructor(protected _db: Redis, protected queueName: string, options?: ProcessOptions) {
    super();
    const queueConnection = this._db.duplicate();
    const workerConnection = this._db.duplicate();
    this._connections = [queueConnection, workerConnection];
    const metrics =
      options?.enableMetrics === true
        ? {
            maxDataPoints: MetricsTime.ONE_WEEK
          }
        : options?.enableMetrics;

    this._queue = new Queue(this.queueName, {
      connection: queueConnection,
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

    this._worker = new Worker<JobDataType<T>, WithTiming<U> | WithTiming<ProcessJobResult>>(
      this.queueName,
      this._processJob.bind(this),
      {
        connection: workerConnection,
        concurrency: options?.concurrency ?? 1,
        autorun: false,
        metrics: metrics || undefined
      }
    );

    this._registerListeners(options?.debug);
  }

  abstract processJob(job: Job<T, U>): Promise<U>;

  async add(job: T, id?: string): Promise<void>;
  async add(jobs: T[]): Promise<void>;
  async add(job: T | T[], id?: string): Promise<void> {
    if (Array.isArray(job) && id) {
      throw new Error(`Can only specify an id for a single job`);
    } else if (!Array.isArray(job) && id) {
      await this.queue.add(
        job.id,
        {
          _processMetadata: {
            type: 'default'
          },
          ...job
        },
        { jobId: id }
      );
    } else {
      const arr = Array.isArray(job) ? job : [job];
      const jobs: {
        name: string;
        data: JobDataType<T>;
        opts?: BulkJobOptions | undefined;
      }[] = arr.map((item) => {
        return {
          name: `${item.id}`,
          data: {
            _processMetadata: {
              type: 'default'
            },
            ...item
          }
        };
      });
      await this._queue.addBulk(jobs);
    }
  }

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
    const queuePromise = this._queue.close();
    const workerPromise = this._worker.close();
    await Promise.all([queuePromise, workerPromise, this._queue.disconnect(), this._worker.disconnect()]).catch(
      (err) => {
        this.error(`Failed to fully close. ${err}`);
      }
    );
    for (const connection of this._connections) {
      connection.disconnect();
    }
    this._cancelProcessListeners?.();
  }

  protected async _processJob(
    job: Job<JobDataType<T>, WithTiming<U> | WithTiming<ProcessJobResult>>
  ): Promise<WithTiming<U> | WithTiming<ProcessJobResult>> {
    const start = Date.now();

    if ('_processMetadata' in job.data && job.data._processMetadata.type === 'health-check') {
      const end = Date.now();
      return {
        timing: {
          created: job.timestamp,
          started: start,
          completed: end
        }
      };
    }

    const result = await this.processJob(job as Job<T, U>);
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

    const handler = async () => {
      try {
        this._cancelProcessListeners = undefined;
        await this.close();
        this.log(`Gracefully closed`);
      } catch (err) {
        this.error(`Error closing process: ${JSON.stringify(err)}`);
      }
    };

    process.once('SIGINT', handler);
    this._cancelProcessListeners = () => {
      process.removeListener('SIGINT', handler);
      process.setMaxListeners(Math.max(process.listenerCount('SIGINT') - 1, 0));
    };
  }

  public async getHealthInfo() {
    try {
      const healthInfo = await this._getCachedHealthInfo();
      if (healthInfo) {
        return healthInfo;
      }

      return await this._getHealthInfo();
    } catch (err) {
      return {
        healthStatus: {
          status: 'unhealthy',
          err
        },
        jobsProcessing: 0,
        jobCounts: {
          waiting: 0
        }
      };
    }
  }

  protected get _healthInfoCacheKey() {
    return `${this.queueName}:health:cache`;
  }

  protected async _getHealthInfo() {
    const [jobsProcessing, jobCounts, healthCheck] = await Promise.all([
      this.queue.count(),
      this.queue.getJobCounts(),
      this.checkHealth()
    ]);

    const healthInfo: HealthInfo = {
      healthStatus: healthCheck,
      jobCounts: jobCounts as HealthInfo['jobCounts'],
      jobsProcessing
    };
    await this._db.set(this._healthInfoCacheKey, JSON.stringify(healthInfo), 'PX', 30_000);
    return healthInfo;
  }

  protected async _getCachedHealthInfo() {
    try {
      const cachedInfoString = await this._db.get(this._healthInfoCacheKey);
      return JSON.parse(cachedInfoString ?? '') as HealthInfo;
    } catch (err) {
      return null;
    }
  }

  public async checkHealth(): Promise<HealthInfo['healthStatus']> {
    const connection = this._db.duplicate();
    const queueEvents = new QueueEvents(this.queueName, {
      connection,
      autorun: true
    });

    try {
      await queueEvents.waitUntilReady();
      let attempts = 0;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        attempts += 1;
        const job = await this._queue.add(
          'health-check',
          {
            id: 'health-check',
            _processMetadata: {
              type: 'health-check'
            }
          },
          { priority: 10 }
        );
        try {
          await job.waitUntilFinished(queueEvents, 2000);
          break;
        } catch (err) {
          if (attempts >= 3) {
            throw err;
          }
        }
      }
      await queueEvents.close();
      await queueEvents.disconnect();
      connection.disconnect();
      return {
        status: 'healthy',
        err: undefined
      };
    } catch (err) {
      await queueEvents.close();
      await queueEvents.disconnect();
      connection.disconnect();
      return {
        status: 'unhealthy',
        err
      };
    }
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
