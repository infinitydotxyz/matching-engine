import { Block, BlockWithMaxFeePerGas } from '@/common/block';
import { ValidityResultWithData } from '@/lib/utils/validity-result';

import { Match, NativeMatchExecutionInfo, NonNativeMatchExecutionInfo } from './types';

export abstract class OrderMatch {
  get id() {
    return this._match.matchId;
  }

  get isListingNative() {
    return this._match.listing.source === 'flow';
  }

  get isOfferNative() {
    return this._match.offer.source === 'flow';
  }

  get isNative() {
    return this.isListingNative && this.isOfferNative;
  }

  public get match() {
    return this._match;
  }

  constructor(protected _match: Match) {}

  abstract verifyMatchAtTarget(
    targetBlock: BlockWithMaxFeePerGas,
    currentBlock: Block
  ): Promise<
    ValidityResultWithData<
      | { native: NativeMatchExecutionInfo; nonNative: NonNativeMatchExecutionInfo }
      | { native: NativeMatchExecutionInfo }
    >
  >;
}
