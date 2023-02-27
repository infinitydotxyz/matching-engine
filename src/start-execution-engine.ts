import { MetricsTime } from 'bullmq';

import { firestore, redis, redlock } from './common/db';
import { logger } from './common/logger';
import { config, getNetworkConfig } from './config';
import { ExecutionEngine } from './lib/execution-engine/v1';
import { MatchExecutor } from './lib/match-executor/match-executor';
import { NonceProvider } from './lib/match-executor/nonce-provider/nonce-provider';
import { OrderbookV1 } from './lib/orderbook';

export const getExecutionEngine = async () => {
  const network = await getNetworkConfig(config.env.chainId);
  const orderbookStorage = new OrderbookV1.OrderbookStorage(redis, config.env.chainId);
  const nonceProvider = new NonceProvider(
    config.env.chainId,
    network.initiator.address,
    network.exchangeAddress,
    redlock,
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
    nonceProvider
  };
};

export const startExecutionEngine = async () => {
  const { executionEngine, nonceProvider } = await getExecutionEngine();
  try {
    const nonceProviderPromise = nonceProvider.run();
    const executionEnginePromise = executionEngine.run();

    await Promise.all([nonceProviderPromise, executionEnginePromise]);
  } catch (err) {
    logger.error(`start-execution-engine`, `Failed to start execution engine ${JSON.stringify(err)}`);

    await executionEngine.close().catch((err) => {
      logger.error(`start-execution-engine`, `Failed to close execution engine ${JSON.stringify(err)}`);
    });
    nonceProvider.close();
  }
};
