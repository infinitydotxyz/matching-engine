import { config as dotenv } from 'dotenv';
import { ethers } from 'ethers';

import { DEFAULT_FLASHBOTS_RELAY, FlashbotsBundleProvider } from '@flashbots/ethers-provider-bundle';
import { ChainId } from '@infinityxyz/lib/types/core';
import { getExchangeAddress } from '@infinityxyz/lib/utils';
import { Erc721 } from '@reservoir0x/sdk/dist/common/helpers';

import { logger } from '@/common/logger';
import { ForkedNetworkBroadcaster } from '@/lib/broadcaster';
import { FlashbotsBroadcaster } from '@/lib/broadcaster/flashbots-broadcaster';

import * as devServiceAccount from './creds/nftc-dev.json';
import * as prodServiceAccount from './creds/nftc-prod.json';

const getEnvVariable = (key: string, required = true): string => {
  if (key in process.env && process.env[key] != null && typeof process.env[key] === 'string') {
    return process.env[key] as string;
  } else if (required) {
    throw new Error(`Missing required environment variable ${key}`);
  }

  return '';
};

const getMode = (): 'dev' | 'prod' => {
  const env = getEnvVariable('INFINITY_NODE_ENV');
  if (!env) {
    return 'prod';
  } else if (env === 'dev' || env === 'prod') {
    return env;
  }

  throw new Error(`Invalid env mode ${env}`);
};

const isForkingEnabled = Number(getEnvVariable('ENABLE_FORKING', false)) === 1;
if (isForkingEnabled) {
  dotenv({ path: '.forked.env', override: true });
}
const mode = getMode();
const chainId = getEnvVariable('CHAIN_ID', true) as ChainId;

export const getNetworkConfig = async (chainId: ChainId) => {
  const chainIdInt = parseInt(chainId, 10);

  const websocketUrl = getEnvVariable('WEBSOCKET_PROVIDER_URL', true);
  const httpUrl = getEnvVariable('HTTP_PROVIDER_URL', true);

  const exchangeAddress = getExchangeAddress(chainId);

  if (isForkingEnabled) {
    const httpProvider = new ethers.providers.JsonRpcProvider(httpUrl, chainIdInt);
    const websocketProvider = new ethers.providers.WebSocketProvider(websocketUrl, chainIdInt);
    const initiator = new ethers.Wallet(getEnvVariable('INITIATOR_KEY', true).trim().toLowerCase()).connect(
      httpProvider
    );
    const matchExecutorAddress = getEnvVariable('MATCH_EXECUTOR_ADDRESS', true).trim().toLowerCase();
    if (!httpUrl.includes('127.0.0.1')) {
      throw new Error('HTTP_PROVIDER_URL must be localhost to use forking');
    }
    const initiatorBalance = await httpProvider.getBalance(initiator.address);

    if (initiatorBalance.eq(0)) {
      logger.error('config', 'Initiator balance is 0, please fund the account');
    }

    return {
      chainId,
      isForkingEnabled: true,
      isFlashbotsEnabled: false,
      initiator,
      matchExecutorAddress,
      exchangeAddress,
      websocketProvider,
      httpProvider,
      broadcaster: new ForkedNetworkBroadcaster(chainId, chainIdInt, httpProvider, {
        provider: httpProvider
      }),
      test: {
        erc721: new Erc721(httpProvider, (process.env.ERC_721_ADDRESS ?? '').trim().toLowerCase()),
        erc721Owner: new ethers.Wallet((process.env.ERC_721_OWNER_KEY ?? '').trim().toLowerCase()),
        testAccount: new ethers.Wallet((process.env.TEST_ACCOUNT_KEY ?? '').trim().toLowerCase())
      }
    };
  } else {
    const httpProvider = new ethers.providers.JsonRpcProvider(httpUrl, chainIdInt);
    const websocketProvider = new ethers.providers.WebSocketProvider(websocketUrl, chainIdInt);
    const initiator = new ethers.Wallet(getEnvVariable('INITIATOR_KEY', true).trim().toLowerCase()).connect(
      httpProvider
    );
    const matchExecutorAddress = getEnvVariable('MATCH_EXECUTOR_ADDRESS', true).trim().toLowerCase();
    const authSigner = new ethers.Wallet(getEnvVariable('FLASHBOTS_AUTH_SIGNER_KEY', true));
    const relayUrl = chainId === ChainId.Mainnet ? DEFAULT_FLASHBOTS_RELAY : 'https://relay-goerli.flashbots.net/';
    const flashbotsProvider = await FlashbotsBundleProvider.create(httpProvider, authSigner, relayUrl, chainIdInt);
    return {
      chainId,
      isForkingEnabled: false,
      isFlashbotsEnabled: true,
      initiator,
      matchExecutorAddress: matchExecutorAddress,
      exchangeAddress: exchangeAddress,
      httpProvider,
      websocketProvider,
      broadcaster: new FlashbotsBroadcaster(chainId, chainIdInt, httpProvider, {
        authSigner,
        flashbotsProvider: flashbotsProvider,
        allowReverts: false
      })
    };
  }
};

export const config = {
  env: {
    mode,
    chainId: chainId,
    debug: Number(getEnvVariable('DEBUG', false)) === 1,
    isForkingEnabled
  },
  orderRelay: {
    enableSyncing: true
  },
  broadcasting: {
    blockOffset: 2
  },
  redis: {
    connectionUrl: getEnvVariable('REDIS_URL')
  },
  firebase: {
    serviceAccount: mode === 'dev' ? devServiceAccount : prodServiceAccount
  }
};
