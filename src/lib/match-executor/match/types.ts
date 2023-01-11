import { BigNumberish } from 'ethers';

import { OrderData } from '@/lib/orderbook/v1/types';

import { Transfer } from '../simulator/types';

export interface Match {
  matchId: string;
  maxGasPriceGwei: number;
  arbitrageWei: string;
  isNative: boolean;
  offer: OrderData;
  listing: OrderData;
}

interface BaseMatchExecutionInfo {
  isNative: boolean;

  orderIds: string[];
}

export interface NativeMatchExecutionInfo extends BaseMatchExecutionInfo {
  isNative: true;

  nativeExecutionTransfers: Transfer[];

  orderNonces: {
    [account: string]: BigNumberish[];
  };
}

export interface NonNativeMatchExecutionInfo extends BaseMatchExecutionInfo {
  isNative: false;

  sourceTxnGasUsage: BigNumberish;
  nonNativeExecutionTransfers: Transfer[];
}

export type MatchExecutionInfo = NativeMatchExecutionInfo | NonNativeMatchExecutionInfo;
