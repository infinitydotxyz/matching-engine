import { ChainNFTs } from '@infinityxyz/lib/types/core';

import { NonNativeMatchExecutionInfo } from '../match/types';
import { Call } from '../types';
import { SourceOrder } from './source-order';

export abstract class NonNativeOrder<RawOrder> extends SourceOrder<RawOrder> {
  abstract getExecutionInfo(taker: string): Promise<Omit<NonNativeMatchExecutionInfo, 'nativeExecutionTransfers'>>;

  abstract getExternalFulfillment(taker: string): Promise<{ call: Call; nftsToTransfer: ChainNFTs[] }>;
}
