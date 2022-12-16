import { MetricsOptions } from 'bullmq';

export interface MatchingEngineOptions {
  enableMetrics?: boolean | MetricsOptions;
  concurrency?: number;
  debug?: boolean;
}

export type JobData<T> = T & {
  timing: {
    created: number;
    started: number;
    completed: number;
  };
};
