import { ethers } from 'ethers';
import { formatUnits } from 'ethers/lib/utils';

import { ChainId, ChainNFTs } from '@infinityxyz/lib/types/core';

import { Block, BlockWithMaxFeePerGas } from '@/common/block';
import { ValidityResult, ValidityResultWithData } from '@/lib/utils/validity-result';

import { NonNativeOrderFactory } from '../order';
import * as Flow from '../order/flow';
import { NonNativeOrder } from '../order/non-native-order';
import { Call, MatchOrders } from '../types';
import { NativeMatch } from './native-match';
import { OrderMatch } from './order-match.abstract';
import { Match, NativeMatchExecutionInfo, NonNativeMatchExecutionInfo } from './types';

export class NonNativeMatch extends OrderMatch {
  protected _nativeMatch: NativeMatch;

  protected _sourceOrder: NonNativeOrder<unknown>;
  constructor(
    match: Match,
    protected _chainId: ChainId,
    orderFactory: Flow.OrderFactory,
    protected provider: ethers.providers.StaticJsonRpcProvider,
    protected _matchExecutorAddress: string
  ) {
    super(match);

    const nonNativeOrders = [match.listing, match.offer].filter((item) => item.source !== 'flow');
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

    const nonNativeOrderFactory = new NonNativeOrderFactory(this._chainId, this.provider);
    this._nativeMatch = new NativeMatch(nativeMatch, _chainId, orderFactory);
    this._sourceOrder = nonNativeOrderFactory.create(nonNativeOrder);
  }

  async prepare(params: { taker: string }): Promise<ValidityResult> {
    const [sourceOrderResult, nativeMatchResult] = await Promise.all([
      this._sourceOrder.prepareOrder(params),
      this._nativeMatch.prepare(params)
    ]);

    if (!sourceOrderResult.isValid) {
      return sourceOrderResult;
    } else if (!nativeMatchResult.isValid) {
      return nativeMatchResult;
    }
    return {
      isValid: true
    };
  }

  async verifyMatchAtTarget(
    targetBlock: BlockWithMaxFeePerGas,
    currentBlock: Block
  ): Promise<ValidityResultWithData<{ native: NativeMatchExecutionInfo; nonNative: NonNativeMatchExecutionInfo }>> {
    const nativeResult = await this._nativeMatch.verifyMatchAtTarget(targetBlock, currentBlock);

    if (!nativeResult.isValid) {
      return nativeResult;
    }
    let nonNativeExecInfo: Omit<NonNativeMatchExecutionInfo, 'nativeExecutionTransfers'>;
    try {
      nonNativeExecInfo = await this._sourceOrder.getExecutionInfo(this._matchExecutorAddress);
    } catch (err) {
      return { isValid: false, reason: err instanceof Error ? err.message : `${err}`, isTransient: true };
    }
    return {
      isValid: true,
      data: {
        native: nativeResult.data.native,
        nonNative: nonNativeExecInfo
      }
    };
  }

  getExternalFulfillment(taker: string): Promise<ValidityResultWithData<{ call: Call; nftsToTransfer: ChainNFTs[] }>> {
    return this._sourceOrder.getExternalFulfillment(taker);
  }

  async getMatchOrders(currentBlockTimestamp: number): Promise<MatchOrders> {
    return this._nativeMatch.getMatchOrders(currentBlockTimestamp);
  }
}
