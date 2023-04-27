import PQueue from 'p-queue';
import phin from 'phin';

import { sleep } from '@infinityxyz/lib/utils';

import { firestore } from '@/common/firestore';
import { getComponentLogger } from '@/common/logger';
import { config } from '@/config';
import { expBackoff } from '@/lib/utils/exp-backoff';
import { SupportedCollectionsProvider } from '@/lib/utils/supported-collections-provider';

export async function startMatchingEngine(version?: string | null) {
  const startTime = Date.now();
  const chainName = config.env.chainName;

  const baseUrl = version
    ? `https://${version}-dot-matching-engine-${chainName}-dot-nftc-infinity.ue.r.appspot.com/`
    : `https://matching-engine-${chainName}-dot-nftc-infinity.ue.r.appspot.com/`;

  const supportedCollections = new SupportedCollectionsProvider(firestore);
  const logger = getComponentLogger('start-matching-engine');

  logger.info(`Starting supported collections for chain ${config.env.chainName}... ${baseUrl}`);

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

  const waitForSyncCompletion = async (baseUrl: string, address: string) => {
    const isSynced = async () => {
      let attempt = 0;
      const url = `${baseUrl}matching/collection/${address}`;
      while (attempt < 5) {
        try {
          const response = await phin({
            url,
            method: 'GET',
            headers: {
              'x-api-key': config.components.api.apiKey
            }
          });

          if (response.statusCode === 200) {
            const result = JSON.parse(response.body.toString());
            return result.isSynced;
          }
          throw new Error(`Failed to get collection status. Status code ${response.statusCode}`);
        } catch (err) {
          logger.error(`Error getting collection status: ${address} ${err}`);
          attempt += 1;
        }
      }
      throw new Error(`Failed to get collection status after 5 attempts`);
    };

    while (!(await isSynced())) {
      logger.info(`Waiting for collection ${address} to sync...`);
      await sleep(5_000);
    }
    logger.info(`Collection ${address} synced!`);
  };

  const queue = new PQueue({ concurrency: 5 });

  for (const { address } of collections) {
    queue
      .add(async () => {
        const url = `${baseUrl}matching/collection/${address}`;
        logger.info(`Starting collection: ${address}`);
        const MAX_ATTEMPTS = 10;
        const backoffGenerator = expBackoff(MAX_ATTEMPTS, 2000);
        for (;;) {
          try {
            const response = await phin({
              url,
              method: 'PUT',
              headers: {
                'x-api-key': config.components.api.apiKey
              }
            });

            if (response.statusCode === 200) {
              await sleep(5000);
              await waitForSyncCompletion(baseUrl, address);
              logger.info(`Started collection: ${address}`);
              return;
            } else if (response.statusCode && response.statusCode >= 500) {
              throw Error(
                `Failed to start collection. Status Code ${response.statusCode} - Server might not be ready for traffic. ${address} - ${url}`
              );
            } else {
              throw new Error(`Failed to start collection. Invalid status code ${response.statusCode}`);
            }
          } catch (err) {
            const backoff = backoffGenerator.next();
            if (backoff.done) {
              logger.error(`Failed to start collection ${address} - ${err}`);
              throw err;
            }
            const { attempts, maxAttempts, delay } = backoff.value;
            logger.info(
              `Failed to start collection ${address}. Attempt ${attempts} of ${maxAttempts} - Retrying in ${delay}ms`
            );
            await sleep(delay);
          }
        }
      })
      .catch((err) => {
        logger.error(`Error starting collection: ${address} - ${err}`);
      });
  }

  await queue.onIdle();

  logger.info(`Started ${collections.length} collections in ${Date.now() - startTime}ms`);
}
