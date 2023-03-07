import { ethers } from 'ethers';

import { FlowExchangeABI, FlowMatchExecutorABI } from '@infinityxyz/lib/abi';

import { getNetworkConfig } from '.';

export const validateNetworkConfig = async (
  _network: ReturnType<typeof getNetworkConfig>
): ReturnType<typeof getNetworkConfig> => {
  const network = await _network;
  const provider = network.httpProvider;

  const exchangeAddress = network.exchangeAddress;
  const matchExecutorAddress = network.matchExecutorAddress;

  const exchange = new ethers.Contract(exchangeAddress, FlowExchangeABI, provider);
  const matchExecutor = new ethers.Contract(matchExecutorAddress, FlowMatchExecutorABI, provider);

  const exchangeMatchExec = await exchange.matchExecutor().then((address: string) => address.toLowerCase());
  if (matchExecutorAddress !== exchangeMatchExec.toLowerCase()) {
    throw new Error(`Match executor mismatch - Config: ${matchExecutorAddress} Expected: ${exchangeMatchExec}`);
  }

  const matchExecutorExchangeAddress = matchExecutor.exchange().then((address: string) => address.toLowerCase());
  if (exchangeAddress !== matchExecutorExchangeAddress) {
    throw new Error(
      `Match executor exchange mismatch - Config: ${exchangeAddress} Expected: ${matchExecutorExchangeAddress}`
    );
  }

  const initiatorAddress = matchExecutor.initiator().then((address: string) => address.toLowerCase());
  if (network.initiator.address.toLowerCase() !== initiatorAddress) {
    throw new Error(
      `Initiator mismatch - Config: ${network.initiator.address.toLowerCase()} Expected: ${initiatorAddress}`
    );
  }

  return network;
};
