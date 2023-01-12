import { config as dotenv } from 'dotenv';
import { HardhatUserConfig } from 'hardhat/types';

import '@nomiclabs/hardhat-ethers';

dotenv();

const config: HardhatUserConfig = {
  defaultNetwork: 'hardhat',
  networks: {
    hardhat: {
      chainId: 1,
      mining: {
        auto: false,
        interval: 15_000
      },
      throwOnCallFailures: true,
      throwOnTransactionFailures: true,
      forking: {
        url: process.env.HTTP_PROVIDER_URL ?? '',
        blockNumber: 16336200
      }
    },
    localhost: {
      chainId: 1,
      url: 'http://127.0.0.1:8545/',
      throwOnCallFailures: true,
      throwOnTransactionFailures: true
    }
  },
  solidity: {
    compilers: [
      {
        version: '0.8.14',
        settings: {
          viaIR: true,
          optimizer: {
            enabled: true,
            runs: 99999999
          }
        }
      }
    ]
  }
};

export default config;
