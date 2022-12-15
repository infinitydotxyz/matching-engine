import { ChainId, ChainOBOrder } from '@infinityxyz/lib/types/core';

export type Status = 'active' | 'inactive' | 'filled' | 'cancelled' | 'expired';

export type OrderParams = {
  id: string;
  chainId: ChainId;
  side: 'buy' | 'sell';
  signer: string;
  numItems: number;
  startPriceWei: string;
  startPriceEth: number;
  endPriceWei: string;
  endPriceEth: number;
  startTime: number;
  endTime: number;
  startTimeMs: number;
  endTimeMs: number;
  nonce: string;
  maxTxGasPriceWei: string;
  maxTxGasPriceGwei: number;
  currency: string;
  complication: string;
  extraParams: string;
  isNative: boolean;
  signedOrder: ChainOBOrder;
};
