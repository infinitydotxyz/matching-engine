import { BigNumberish } from 'ethers';

import { ChainNFTs, ChainOBOrder } from '@infinityxyz/lib/types/core';

export interface Call {
  /**
   * raw call data
   */
  data: string;

  /**
   * value to send with the call
   */
  value: BigNumberish;

  /**
   * contract to call
   */
  to: string;
}

export interface ExternalFulfillments {
  calls: Call[];
  nftsToTransfer: ChainNFTs[];
}

export enum MatchOrdersType {
  OneToOneSpecific,
  OneToOneUnspecific,
  OneToMany
}

export interface MatchOrders {
  buys: ChainOBOrder[];
  sells: ChainOBOrder[];
  constructs: ChainNFTs[][];
  matchType: MatchOrdersType;
}

export interface Batch {
  externalFulfillments: ExternalFulfillments;
  matches: MatchOrders[];
}

export interface OneToOneSpecificMatch {
  buy: ChainOBOrder;
  sell: ChainOBOrder;
  matchType: MatchOrdersType.OneToOneSpecific;
}

export interface OneToOneUnspecificMatch {
  buy: ChainOBOrder;
  sell: ChainOBOrder;
  construct: {
    collection: string;
    tokenId: string;
  };
  matchType: MatchOrdersType.OneToOneUnspecific;
}

export interface OneBuyToManySellMatch {
  buy: ChainOBOrder;
  sells: ChainOBOrder[];
  constructs: ChainNFTs[][];
  matchType: MatchOrdersType.OneToMany;
}

export interface OneSellToManyBuyMatch {
  sell: ChainOBOrder;
  buys: ChainOBOrder[];
  constructs: ChainNFTs[][];
  matchType: MatchOrdersType.OneToMany;
}

export type FlowMatch = OneToOneSpecificMatch | OneToOneUnspecificMatch | OneBuyToManySellMatch | OneSellToManyBuyMatch;
