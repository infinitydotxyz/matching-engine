import { CloudRedisClient } from '@google-cloud/redis';
import { ChainId } from '@infinityxyz/lib/types/core';
import { sleep } from '@infinityxyz/lib/utils';

export async function deployRedis(config: {
  projectId: string;
  region: string;
  chainId: ChainId;
  chainName: string;
  version: string;
  memorySizeGb: number;
  replicaCount: number;
}) {
  const client = new CloudRedisClient({ projectId: config.projectId });
  const name = `matching-engine-${config.chainName}-${config.version}`;
  const formattedParent = client.locationPath(config.projectId, config.region);
  await client.createInstance({
    parent: formattedParent,
    instanceId: name,
    instance: {
      name,
      displayName: `${config.chainName} matching engine`,
      redisVersion: 'REDIS_6_X',
      redisConfigs: {
        'maxmemory-policy': 'noeviction'
      },
      tier: 'STANDARD_HA',
      memorySizeGb: config.memorySizeGb,
      authorizedNetwork: `projects/${config.projectId}/global/networks/default`,
      connectMode: 'PRIVATE_SERVICE_ACCESS',
      authEnabled: false,
      transitEncryptionMode: 'DISABLED',
      replicaCount: config.replicaCount,
      readReplicasMode: config.replicaCount > 0 ? 'READ_REPLICAS_ENABLED' : 'READ_REPLICAS_DISABLED'
    }
  });

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const instanceName = `projects/${config.projectId}/locations/${config.region}/instances/${name}`;
    const instance = await client.getInstance({
      name: instanceName
    });

    const item = instance[0];

    if (!item) {
      console.log(`Failed to find instance ${instanceName}`);
    } else {
      if (item.host) {
        console.log(`Instance deployed. Host ${item.host} Port ${item.port}`);
        console.log(`Read endpoint. Host ${item.readEndpoint} Port ${item.readEndpointPort}`);
        return;
      }

      console.log('Deploying...');
    }
    await sleep(5000);
  }
}
