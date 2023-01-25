import { ethers } from 'ethers';
import { formatUnits } from 'ethers/lib/utils';

import { ChainId, ChainNFTs } from '@infinityxyz/lib/types/core';

import { Block, BlockWithMaxFeePerGas } from '@/common/block';
import { ValidityResult } from '@/lib/utils/validity-result';

import { Seaport } from '../order';
import * as Infinity from '../order/infinity';
import { Call, MatchOrders } from '../types';
import { NativeMatch } from './native-match';
import { OrderMatch } from './order-match.abstract';
import { Match, NativeMatchExecutionInfo, NonNativeMatchExecutionInfo } from './types';

export class NonNativeMatch extends OrderMatch {
  protected _nativeMatch: NativeMatch;

  protected _sourceOrder: Seaport.SingleTokenOrder;
  constructor(
    match: Match,
    protected _chainId: ChainId,
    orderFactory: Infinity.OrderFactory,
    protected provider: ethers.providers.StaticJsonRpcProvider,
    protected _matchExecutorAddress: string
  ) {
    super(match);

    const nonNativeOrders = [match.listing, match.offer].filter((item) => item.source !== 'infinity');
    const nonNativeOrder = nonNativeOrders[0];
    if (nonNativeOrders.length !== 1 || !nonNativeOrder) {
      throw new Error('Expected one non-native order');
    }

    const nativeListing = nonNativeOrder.order.isSellOrder ? nonNativeOrder.order : match.listing.order;
    const nativeOffer = nonNativeOrder.order.isSellOrder ? match.offer.order : nonNativeOrder.order;

    const nativeMatch: Match = {
      matchId: match.matchId,
      maxGasPriceGwei: parseFloat(formatUnits(nativeListing.constraints[6].toString(), 'gwei')),
      arbitrageWei: '0',
      isNative: true,
      offer: {
        ...match.offer,
        order: nativeOffer
      },
      listing: {
        ...match.listing,
        order: nativeListing
      }
    };
    this._nativeMatch = new NativeMatch(nativeMatch, _chainId, orderFactory);
    this._sourceOrder = new Seaport.SingleTokenOrder(nonNativeOrder, _chainId, provider);
  }

  async verifyMatchAtTarget(
    targetBlock: BlockWithMaxFeePerGas,
    currentBlock: Block
  ): Promise<ValidityResult<{ native: NativeMatchExecutionInfo; nonNative: NonNativeMatchExecutionInfo }>> {
    const nativeResult = await this._nativeMatch.verifyMatchAtTarget(targetBlock, currentBlock);

    if (!nativeResult.isValid) {
      return nativeResult;
    }
    let nonNativeExecInfo: Omit<NonNativeMatchExecutionInfo, 'nativeExecutionTransfers'>;
    try {
      nonNativeExecInfo = await this._sourceOrder.getExecutionInfo(this._matchExecutorAddress);
    } catch (err) {
      return { isValid: false, reason: err instanceof Error ? err.message : `${err}` };
    }
    return {
      isValid: true,
      data: {
        native: nativeResult.data.native,
        nonNative: nonNativeExecInfo
      }
    };
  }

  getExternalFulfillment(taker: string): Promise<{ call: Call; nftsToTransfer: ChainNFTs[] }> {
    return this._sourceOrder.getExternalFulfillment(taker);
  }

  async getMatchOrders(currentBlockTimestamp: number): Promise<MatchOrders> {
    return this._nativeMatch.getMatchOrders(currentBlockTimestamp);
  }
}
