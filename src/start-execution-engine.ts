import { MetricsTime } from 'bullmq';

import { firestore, redis, redlock } from './common/db';
import { logger } from './common/logger';
import { config, getNetworkConfig } from './config';
import { validateNetworkConfig } from './config/validate-network';
import { BlockScheduler } from './lib/block-scheduler';
import { ExecutionEngine } from './lib/execution-engine/v1';
import { MatchExecutor } from './lib/match-executor/match-executor';
import { NonceProvider } from './lib/match-executor/nonce-provider/nonce-provider';
import { OrderbookV1 } from './lib/orderbook';

let hasValidated = false;
export const getExecutionEngine = async () => {
  let network = await getNetworkConfig(config.env.chainId);
  if (!hasValidated) {
    network = await validateNetworkConfig(Promise.resolve(network));
    hasValidated = true;
  }

  const orderbookStorage = new OrderbookV1.OrderbookStorage(redis, firestore, config.env.chainId);
  const nonceProvider = new NonceProvider(
    config.env.chainId,
    network.initiator.address,
    network.exchangeAddress,
    network.httpProvider,
    firestore
  );

  const matchExecutor = new MatchExecutor(
    config.env.chainId,
    network.matchExecutorAddress,
    network.initiator,
    nonceProvider
  );

  const executionEngine = new ExecutionEngine<unknown>(
    config.env.chainId,
    orderbookStorage,
    redis,
    redlock,
    network.websocketProvider,
    network.httpProvider,
    matchExecutor,
    config.broadcasting.blockOffset,
    network.broadcaster,
    {
      debug: config.env.debug,
      concurrency: 20,
      enableMetrics: {
        maxDataPoints: MetricsTime.ONE_WEEK * 2
      }
    }
  );

  return {
    matchExecutor,
    executionEngine,
    nonceProvider,
    network
  };
};

export const startExecutionEngine = async () => {
  const { executionEngine, network } = await getExecutionEngine();
  const blockScheduler = new BlockScheduler(
    redis,
    config.env.chainId,
    [executionEngine],
    network.websocketProvider,
    network.httpProvider,
    {
      debug: config.env.debug,
      concurrency: 1,
      enableMetrics: false
    }
  );
  try {
    const executionEnginePromise = executionEngine.run();
    const blockSchedulerPromise = blockScheduler.run();

    await Promise.all([executionEnginePromise, blockSchedulerPromise]);
  } catch (err) {
    logger.error(`start-execution-engine`, `Failed to start execution engine ${JSON.stringify(err)}`);

    await executionEngine.close().catch((err) => {
      logger.error(`start-execution-engine`, `Failed to close execution engine ${JSON.stringify(err)}`);
    });
    await blockScheduler.close();
  }
};
