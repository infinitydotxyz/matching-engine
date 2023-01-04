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
      forking: {
        enabled: true,
        url: 'https://eth-mainnet.g.alchemy.com/v2/RJUo8ydCEfcC9L2mBWgHfbudhC-tEq69'
      }
    },
    localhost: {
      url: 'http://127.0.0.1:8545/',
      chainId: 1
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
