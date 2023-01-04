import { ChainId, OrderSource } from '@infinityxyz/lib/types/core';
import * as Sdk from '@reservoir0x/sdk';

import { OrderMatch } from './order-match';
import { Match } from './types';
import { BigNumberish } from 'ethers';
import { InfinityMatch } from '../types';

interface CurrencyBalanceChange {
    tokenAddress: string;
    walletAddress: string;
    initialBalance: string;
    finalBalance: string;
}

interface Erc721BalanceChange {
    tokenAddress: string;
    walletAddress: string;
    tokenId: string;
    initialBalance: string;
    finalBalance: string;
}

type BalanceChange = CurrencyBalanceChange | Erc721BalanceChange;

interface ExecInfo {
    isNative: boolean;
    gasUsage: string;
}

interface NativeExecInfo extends ExecInfo {
    isNative: true;

    nativeMatches: {
        match: InfinityMatch;
        balanceChanges: BalanceChange[];
    }[];
}


interface NonNativeExecInfo extends ExecInfo {
    isNative: false;

    nonNativeMatches: {
        balanceChanges: BalanceChange[];
    }[];

    nativeMatches: {
        match: InfinityMatch;
        balanceChanges: BalanceChange[];
    }[];



interface FulfillmentData {
    gasUsage: string;
    
    balanceChanges: BalanceChange[];

    execInfo: { 
        
    }[]
}

export abstract class SourceMatches<T> {
  abstract readonly source: OrderSource;

  get chainId() {
    return parseInt(this._chainId, 10);
  }

  constructor(protected _matches: OrderMatch<T>[], protected _chainId: ChainId) {}

  abstract getFulfillmentData(): 

  getFulfillmentData() {
    const exchange = new Sdk.Seaport.Exchange(this.chainId);
    const execInfo: T[] = this._matches.map((item) => {
      return item.getExecInfo();
    });

    for (const match of this._matches) {
      const taker = '';
      exchange.fillOrdersTx(taker);
    }

    // fillOrdersTx(taker: string, orders: Order[], matchParams: Types.MatchParams[], options?: {
    //     recipient?: string;
    //     conduitKey?: string;
    //     source?: string;
    //     maxOrdersToFulfill?: number;
    // }): TxData;
  }
}
