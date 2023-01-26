import { Block, BlockWithMaxFeePerGas } from '@/common/block';
import { ValidityResult } from '@/lib/utils/validity-result';

import { Match, NativeMatchExecutionInfo, NonNativeMatchExecutionInfo } from './types';

export abstract class OrderMatch {
  get id() {
    return this._match.matchId;
  }

  get isListingNative() {
    return this._match.listing.source === 'infinity';
  }

  get isOfferNative() {
    return this._match.offer.source === 'infinity';
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
    ValidityResult<
      | { native: NativeMatchExecutionInfo; nonNative: NonNativeMatchExecutionInfo }
      | { native: NativeMatchExecutionInfo }
    >
  >;
}
