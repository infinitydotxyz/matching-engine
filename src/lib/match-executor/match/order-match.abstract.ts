import { BigNumberish } from 'ethers';

import { ValidityResult } from '@/lib/utils/validity-result';

import { Match, MatchExecutionInfo } from './types';

export abstract class OrderMatch<T extends MatchExecutionInfo> {
  get isListingNative() {
    return this._match.listing.source === 'infinity';
  }

  get isOfferNative() {
    return this._match.offer.source === 'infinity';
  }

  get isNative() {
    return this.isListingNative && this.isOfferNative;
  }

  constructor(protected _match: Match) {}

  abstract verifyMatchAtTarget(
    targetBlock: {
      timestamp: number;
      blockNumber: number;
      gasPrice: BigNumberish;
    },
    currentBlockTimestamp: number
  ): Promise<ValidityResult<T>>;
}
