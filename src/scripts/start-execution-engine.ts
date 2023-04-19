import phin from 'phin';

import { getComponentLogger } from '@/common/logger';
import { config } from '@/config';

async function main() {
  const args = process.argv.slice(2);
  const version = args.find((item) => item.toLowerCase().startsWith('version='))?.split?.('=')?.[1] ?? null;
  const chainName = config.env.chainName;

  const baseUrl = version
    ? `https://${version}-dot-execution-engine-${chainName}-dot-nftc-infinity.ue.r.appspot.com/`
    : `https://execution-engine-${chainName}-dot-nftc-infinity.ue.r.appspot.com/`;

  const logger = getComponentLogger('start-execution-engine');

  logger.info(`Starting execution engine for chain ${config.env.chainName}... ${baseUrl}`);
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
    } else {
      throw new Error(`Failed to start execution engine. Invalid status code ${response.statusCode}`);
    }
  } catch (err) {
    logger.error(`Error starting execution engine - ${err}`);
    throw err;
  }
  process.exit(1);
}

void main();
