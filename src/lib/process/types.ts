import { MetricsOptions } from 'bullmq';

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
