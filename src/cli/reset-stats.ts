import phin from 'phin';

import { firestore } from '@/common/firestore';
import { getComponentLogger } from '@/common/logger';
import { config } from '@/config';
import { SupportedCollectionsProvider } from '@/lib/utils/supported-collections-provider';

async function main() {
  const args = process.argv.slice(2);
  const version = args.find((item) => item.toLowerCase().startsWith('version='))?.split?.('=')?.[1] ?? null;
  const chainName = config.env.chainName;

  const baseUrl = version
    ? `https://${version}-dot-matching-engine-${chainName}-dot-nftc-infinity.ue.r.appspot.com/`
    : `https://matching-engine-${chainName}-dot-nftc-infinity.ue.r.appspot.com/`;

  const supportedCollections = new SupportedCollectionsProvider(firestore);
  const logger = getComponentLogger('reset-stats');

  logger.info(`Resetting stats for chain ${config.env.chainName}... ${baseUrl}`);

  logger.info('Getting supported collections...');
  await supportedCollections.init();
  const collections = [...supportedCollections.values()]
    .map((id) => {
      const [chainId, address] = id.split(':');
      return {
        chainId,
        address
      };
    })
    .filter((item) => item.chainId === config.env.chainId);

  logger.info(`Found ${collections.length} supported collections for chain ${config.env.chainId}`);

  for (const { address } of collections) {
    const url = `${baseUrl}matching/collection/${address}/reset-stats`;
    logger.info(`Resetting stats for collection: ${address}`);
    try {
      const response = await phin({
        url,
        method: 'PUT',
        headers: {
          'x-api-key': config.components.api.apiKey
        }
      });

      if (response.statusCode === 200) {
        logger.info(`Reset stats for collection: ${address}`);
      } else {
        throw new Error(`Failed to reset stats. Invalid status code ${response.statusCode}`);
      }
    } catch (err) {
      logger.error(`Error resetting stats for collection: ${address} - ${url} ${err}`);
      throw err;
    }
  }

  process.exit(1);
}

void main();
