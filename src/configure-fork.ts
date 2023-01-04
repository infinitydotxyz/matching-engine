import { config } from 'dotenv';
import { ethers as _ethers, ethers } from 'ethers';
import { writeFile } from 'fs/promises';
import * as hh from 'hardhat';
import { network } from 'hardhat';

import { InfinityExchangeABI } from '@infinityxyz/lib/abi';
import { ChainId } from '@infinityxyz/lib/types/core';
import { getExchangeAddress } from '@infinityxyz/lib/utils';
import '@nomiclabs/hardhat-ethers';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { Infinity, Seaport } from '@reservoir0x/sdk';

import { logger } from './common/logger';

const getExchange = async (provider: _ethers.providers.JsonRpcProvider, chainId: ChainId) => {
  const contractAddress = getExchangeAddress(chainId);
  const contract = new _ethers.Contract(contractAddress, InfinityExchangeABI, provider);
  const ownerAddress: string = await contract.owner();

  return {
    address: contractAddress,
    ownerAddress,
    contract
  };
};

const fundAccount = async (
  from: SignerWithAddress,
  to: ethers.Wallet | ethers.Signer,
  provider: ethers.providers.JsonRpcProvider
) => {
  const funderBalance = await from.getBalance();
  const txn = await from.sendTransaction({
    value: funderBalance.div(2).toString(),
    to: await to.getAddress()
  });

  await provider.waitForTransaction(txn.hash, 1);
};

const setupForkedExecutor = async (
  chainId: number,
  provider: _ethers.providers.JsonRpcProvider,
  initiator: _ethers.Signer,
  exchangeContract: ethers.Contract,
  contractOwner: _ethers.Signer
) => {
  logger.log('fork', 'Deploying match executor contract');
  const matchExecutor = await hh.ethers.deployContract(
    'MatchExecutor',
    [exchangeContract.address],
    initiator.connect(provider)
  );
  logger.log('fork', `Deployed match executor to ${matchExecutor.address}`);

  logger.log('fork', 'Setting match executor on exchange contract');
  const txn = await exchangeContract.connect(contractOwner).updateMatchExecutor(matchExecutor.address);

  await provider.waitForTransaction((txn as unknown as { hash: string }).hash, 1);
  logger.log('fork', 'Updated match executor on exchange contract');

  logger.log('fork', 'Enabling exchanges...');
  const exchanges = [Infinity.Addresses.Exchange[chainId], Seaport.Addresses.Exchange[chainId]];

  for (const item of exchanges) {
    const txn = await matchExecutor.connect(initiator.connect(provider)).addEnabledExchange(item);
    await txn.wait();
  }
  logger.log('fork', 'Exchanges enabled');

  return {
    matchExecutorAddress: matchExecutor.address,
    exchangeAddress: exchangeContract.address
  };
};

async function resetFork(chainIdInt: number) {
  config();
  const providerUrl = process.env.HTTP_PROVIDER_URL;
  const provider = new ethers.providers.JsonRpcProvider(providerUrl, chainIdInt);
  const currentBlock = await provider.getBlockNumber();
  const blockNumber = currentBlock - 10;

  logger.log('fork', `Resetting fork to block ${blockNumber}...`);

  await network.provider.request({
    method: 'hardhat_reset',
    params: [
      {
        forking: {
          jsonRpcUrl: providerUrl,
          blockNumber: blockNumber
        }
      }
    ]
  });

  logger.log('fork', `Reset fork to block ${blockNumber}`);
}

async function main() {
  await network.provider.send('evm_setAutomine', [true]);
  await network.provider.send('evm_setIntervalMining', [0]);
  const chainId = process.env.CHAIN_ID as ChainId;
  const chainIdInt = parseInt(chainId, 10);
  await resetFork(chainIdInt);
  const httpUrl = 'http://127.0.0.1:8545/';
  const websocketUrl = 'ws://127.0.0.1:8545/';
  const httpProvider = new _ethers.providers.JsonRpcProvider(httpUrl, chainIdInt);

  logger.log('fork', 'Funding accounts...');
  const [_initiator, _contractOwner] = await hh.ethers.getSigners();
  const initiator = ethers.Wallet.createRandom();

  const { ownerAddress, contract: exchangeContract } = await getExchange(httpProvider, chainId);
  const contractOwner = await hh.ethers.getImpersonatedSigner(ownerAddress);

  const initiatorFundingPromise = fundAccount(_initiator, initiator, httpProvider);
  const contractOwnerFundingPromise = fundAccount(_contractOwner, contractOwner, httpProvider);

  await Promise.all([initiatorFundingPromise, contractOwnerFundingPromise]);
  logger.log('fork', 'Funded accounts');

  const { matchExecutorAddress, exchangeAddress } = await setupForkedExecutor(
    chainIdInt,
    httpProvider,
    initiator,
    exchangeContract,
    contractOwner
  );
  const data = `
INITIATOR_KEY="${initiator.privateKey}"
MATCH_EXECUTOR_ADDRESS="${matchExecutorAddress}"
EXCHANGE_ADDRESS="${exchangeAddress}"
CHAIN_ID="${chainId}"
HTTP_PROVIDER_URL="${httpUrl}"
WEBSOCKET_PROVIDER_URL="${websocketUrl}"
`;

  await network.provider.send('evm_setAutomine', [false]);
  await network.provider.send('evm_setIntervalMining', [15_000]);
  await writeFile('./.forked.env', data);
}

main().catch((err) => {
  console.error(err);
});
