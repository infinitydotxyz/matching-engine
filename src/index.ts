import { config, getNetworkConfig } from '@/config';
import { getProcesses } from '@/lib/collections-queue/start-collection';

import { logger } from './common/logger';
import { startExecutionEngine } from './start-execution-engine';

async function main() {
  const network = await getNetworkConfig(config.env.chainId);

  logger.info(
    'process',
    `Starting server with config: ${config.env.mode} Using forked network: ${network.isForkingEnabled}`
  );

  const collection = '0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d'.toLowerCase();

  const promises = [];

  if (config.components.matchingEngine.enabled) {
    const { matchingEngine, orderRelay } = getProcesses(collection);
    if (config.components.matchingEngine.enableSyncing) {
      logger.info('process', 'Starting order relay');
      const orderRelayPromise = orderRelay.run();
      promises.push(orderRelayPromise);
    }
    logger.info('process', 'Starting matching engine');
    const matchingEnginePromise = matchingEngine.run();
    promises.push(matchingEnginePromise);
  }

  if (config.components.executionEngine.enabled) {
    logger.info('process', 'Starting execution engine');
    promises.push(startExecutionEngine());
  }

  await Promise.all(promises);
}

void main();
