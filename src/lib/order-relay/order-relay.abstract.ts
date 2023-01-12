import Redis from 'ioredis';

import { logger } from '@/common/logger';

import { AbstractOrderbook } from '../orderbook/orderbook.abstract';
import { AbstractProcess } from '../process/process.abstract';
import { ProcessOptions, WithTiming } from '../process/types';

interface OrderRelayEventsListener {
  /**
   * This event is triggered when the order relay
   * begins loading the most recent snapshot
   */
  snapshotLoading(): void;

  /**
   * This event is triggered once the full snapshot has been processed
   */
  snapshotLoaded: (args: WithTiming<{ numOrders: number }>) => void;

  /**
   * This event is triggered when the order relay
   * begins syncing order events
   */
  orderbookSyncing: () => void;

  /**
   * This event is triggered every time the cursor is updated
   * while syncing the order events
   */
  orderbookSyncingProgress: (args: {
    numEventsProcessed: number;
    timestampLastItem: number;
    percentComplete: number;
  }) => void;

  /**
   * This event is triggered once the orderbook has been synced
   */
  orderbookSynced: (args: WithTiming<{ numEventsProcessed: number }>) => void;
}

/**
 * An OrderRelay is an abstraction for a service that maintains the orderbook
 */
export abstract class AbstractOrderRelay<T, U, JobData extends { id: string }, JobResult> extends AbstractProcess<
  JobData,
  JobResult
> {
  constructor(protected _orderbook: AbstractOrderbook<T, U>, db: Redis, queueName: string, options?: ProcessOptions) {
    super(db, queueName, options);
  }

  emit<E extends keyof OrderRelayEventsListener>(event: E, ...args: Parameters<OrderRelayEventsListener[E]>): boolean {
    return super.emit(event, ...args);
  }

  off<E extends keyof OrderRelayEventsListener>(eventName: E, listener: OrderRelayEventsListener[E]): this {
    super.off(eventName, listener);
    return this;
  }

  on<E extends keyof OrderRelayEventsListener>(event: E, listener: OrderRelayEventsListener[E]): this {
    super.on(event, listener);
    return this;
  }

  once<E extends keyof OrderRelayEventsListener>(event: E, listener: OrderRelayEventsListener[E]): this {
    super.once(event, listener);
    return this;
  }

  protected _registerListeners(verbose?: boolean): void {
    if (verbose) {
      this.on('snapshotLoading', () => {
        logger.log('order-relay', 'Loading snapshot');
      });

      this.on('snapshotLoaded', (args) => {
        logger.log(
          'order-relay',
          `Loaded snapshot with ${args.numOrders} orders in ${args.timing.completed - args.timing.started}ms`
        );
      });

      this.on('orderbookSyncing', () => {
        logger.log('order-relay', 'Orderbook syncing initiated');
      });

      this.on('orderbookSyncingProgress', (args) => {
        logger.log(
          'order-relay',
          `Orderbook syncing... ${args.numEventsProcessed} events processed. ${args.percentComplete}% complete`
        );
      });

      this.on('orderbookSynced', (args) => {
        logger.log(
          'order-relay',
          `Orderbook synced with ${args.numEventsProcessed} events in ${args.timing.completed - args.timing.started}ms`
        );
      });
    }

    this._registerWorkerListeners(verbose);
  }
}
