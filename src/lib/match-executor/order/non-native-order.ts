import { ChainNFTs } from '@infinityxyz/lib/types/core';

import { ValidityResultWithData } from '@/lib/utils/validity-result';

import { NonNativeMatchExecutionInfo } from '../match/types';
import { Call } from '../types';
import { SourceOrder } from './source-order';

export abstract class NonNativeOrder<RawOrder> extends SourceOrder<RawOrder> {
  abstract getExecutionInfo(taker: string): Promise<Omit<NonNativeMatchExecutionInfo, 'nativeExecutionTransfers'>>;

  abstract getExternalFulfillment(
    taker: string
  ): Promise<ValidityResultWithData<{ call: Call; nftsToTransfer: ChainNFTs[] }>>;
}
