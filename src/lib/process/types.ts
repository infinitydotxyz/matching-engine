import { MetricsOptions } from 'bullmq';

export type ProcessJobResult = Record<string, unknown>;

export type DefaultJob<T> = {
  id: string;
  _processMetadata: {
    type: 'default';
  };
} & T;

export interface HealthCheckJob {
  id: string;
  _processMetadata: {
    type: 'health-check';
  };
}

export type JobDataType<T> = DefaultJob<T> | HealthCheckJob;

export type WithTiming<T> = T & {
  timing: {
    created: number;
    started: number;
    completed: number;
  };
};

export interface ProcessOptions {
  enableMetrics?: boolean | MetricsOptions;
  concurrency?: number;
  debug?: boolean;
  attempts?: number;
  delay?: number;
}

export interface HealthInfo {
  healthStatus: {
    status: 'healthy' | 'unhealthy';
    err: unknown;
  };
  jobsProcessing: number;
  jobCounts: {
    waiting: number;
  };
}
