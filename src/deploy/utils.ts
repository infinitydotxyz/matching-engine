import { ChainId } from '@infinityxyz/lib/types/core';

export function getChainName(chainId: ChainId) {
  let chainName: string;
  switch (chainId) {
    case '1':
      chainName = 'mainnet';
      break;
    case '5':
      chainName = 'goerli';
      break;
    default:
      throw new Error(`ChainId ${chainId} not yet supported`);
  }

  return chainName;
}
