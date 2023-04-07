import { config } from 'dotenv';

import { ChainId } from '@infinityxyz/lib/types/core';

import { deployRedis } from './deploy-redis';
import { getChainName } from './utils';

config({
  path: '.env.script.deploy'
});

const chainId = process.env.CHAIN_ID as ChainId;
const chainName = getChainName(chainId);
const projectId = process.env.PROJECT_ID ?? '';
const region = 'us-east1';

void deployRedis({
  chainId,
  chainName,
  region,
  projectId,
  version: '1',
  memorySizeGb: chainId === ChainId.Mainnet ? 40 : 2,
  replicaCount: 1
});
