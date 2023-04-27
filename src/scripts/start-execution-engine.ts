import phin from 'phin';

import { sleep } from '@infinityxyz/lib/utils';

import { getComponentLogger } from '@/common/logger';
import { config } from '@/config';
import { expBackoff } from '@/lib/utils/exp-backoff';

export async function startExecutionEngine(version?: string | null) {
  const chainName = config.env.chainName;

  const baseUrl = version
    ? `https://${version}-dot-execution-engine-${chainName}-dot-nftc-infinity.ue.r.appspot.com/`
    : `https://execution-engine-${chainName}-dot-nftc-infinity.ue.r.appspot.com/`;

  const logger = getComponentLogger('start-execution-engine');

  logger.info(`Starting execution engine for chain ${config.env.chainName}... ${baseUrl}`);
  const backoffGenerator = expBackoff(10, 2);
  for (;;) {
    try {
      const url = `${baseUrl}execution`;
      const response = await phin({
        url,
        method: 'PUT',
        headers: {
          'x-api-key': config.components.api.apiKey
        }
      });
      if (response.statusCode === 200) {
        logger.info(`Started execution engine`);
        return;
      } else {
        throw new Error(`Failed to start execution engine. Invalid status code ${response.statusCode}`);
      }
    } catch (err) {
      const backoff = backoffGenerator.next();
      if (backoff.done) {
        logger.error(`Failed to start execution engine - ${err}`);
        throw err;
      }
      const { attempts, maxAttempts, delay } = backoff.value;
      logger.info(`Failed to start execution engine. Attempt ${attempts} of ${maxAttempts} - Retrying in ${delay}ms`);
      await sleep(delay);
    }
  }
}
