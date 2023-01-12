import { ChainId } from '@infinityxyz/lib/types/core';

export interface NonceProviderDoc {
  updatedAt: number;
  createdAt: number;
  chainId: ChainId;
  matchExecutorAddress: string;
  exchangeAddress: string;
  nonce: string;
}
