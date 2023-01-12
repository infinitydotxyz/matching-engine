import { ChainId, ChainOBOrder, OrderSource, OrderStatus } from '@infinityxyz/lib/types/core';

export type Status = OrderStatus;

export interface OrderData {
  id: string;
  order: ChainOBOrder;
  source: OrderSource;
  sourceOrder: unknown;
  gasUsage: string;
  status: Status;
}

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
