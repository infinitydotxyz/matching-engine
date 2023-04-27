import { startExecutionEngine } from 'scripts/start-execution-engine';
import { startMatchingEngine } from 'scripts/start-matching-engine';

import { sleep } from '@infinityxyz/lib/utils';

import { config, getNetworkConfig } from '@/config';
import { getProcesses } from '@/lib/collections-queue/start-collection';

import { logger } from './common/logger';
import { validateNetworkConfig } from './config/validate-network';
import { initExecutionEngine } from './init-execution-engine';

async function main() {
  const network = await validateNetworkConfig(getNetworkConfig(config.env.chainId));

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

    if (config.env.isDeployed) {
      promises.push(sleep(5000).then(() => startMatchingEngine(config.env.version)));
    }
  }

  if (config.components.executionEngine.enabled) {
    logger.info('process', 'Starting execution engine');
    const initExecutionEnginePromise = initExecutionEngine();
    promises.push(initExecutionEnginePromise);

    if (config.env.isDeployed) {
      promises.push(sleep(5000).then(() => startExecutionEngine(config.env.version)));
    }
  }

  await Promise.all(promises);
}

void main();
