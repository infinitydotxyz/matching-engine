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

const args = process.argv.slice(2);
const version = args.find((item) => item.toLowerCase().startsWith('version='))?.split?.('=')?.[1] ?? null;

if (!version) {
  throw new Error('version flag is required (npm run <script> -- version=1)');
}

void deployRedis({
  chainId,
  chainName,
  region,
  projectId,
  version,
  memorySizeGb: chainId === ChainId.Mainnet ? 10 : 2,
  replicaCount: 1
});
