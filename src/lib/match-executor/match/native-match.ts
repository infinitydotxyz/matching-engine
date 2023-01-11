import { BigNumber, BigNumberish } from 'ethers';

import { ChainId, ChainOBOrder } from '@infinityxyz/lib/types/core';
import { getExchangeAddress, orderHash } from '@infinityxyz/lib/utils';
import { Common } from '@reservoir0x/sdk';

import { ValidityResult } from '@/lib/utils/validity-result';

import * as Infinity from '../order/infinity';
import { Erc721Transfer, EthTransfer, TransferKind, WethTransfer } from '../simulator/types';
import { OrderMatch } from './order-match.abstract';
import { Match, NativeMatchExecutionInfo } from './types';

export class NativeMatch extends OrderMatch<NativeMatchExecutionInfo> {
  protected _listing: Infinity.MatchExecutorOrder | Infinity.EndUserOrder;
  protected _offer: Infinity.MatchExecutorOrder | Infinity.EndUserOrder;

  constructor(match: Match, protected _chainId: ChainId, orderFactory: Infinity.OrderFactory) {
    super(match);
    this._listing = orderFactory.createOrder(match.listing);
    this._offer = orderFactory.createOrder(match.offer);
  }

  async verifyMatchAtTarget(
    targetBlock: {
      timestamp: number;
      blockNumber: number;
      gasPrice: BigNumberish;
    },
    currentBlockTimestamp: number
  ): Promise<ValidityResult<NativeMatchExecutionInfo>> {
    if (this._listing.isMatchExecutorOrder && this._offer.isMatchExecutorOrder) {
      return {
        isValid: false,
        reason: 'Listing and offer are both match executor orders'
      };
    }

    const offer = await this._offer.getChainOrder(this._listing.params, currentBlockTimestamp);
    const listing = await this._listing.getChainOrder(this._offer.params, currentBlockTimestamp);

    if (offer.signer === listing.signer) {
      return {
        isValid: false,
        reason: 'Listing and offer have the same signer'
      };
    } else if (!offer.sig) {
      return {
        isValid: false,
        reason: 'Offer signature is missing'
      };
    } else if (!listing.sig) {
      return {
        isValid: false,
        reason: 'Listing signature is missing'
      };
    } else if (offer.isSellOrder) {
      return {
        isValid: false,
        reason: 'Offer is a sell order'
      };
    } else if (!listing.isSellOrder) {
      return {
        isValid: false,
        reason: 'Listing is not a sell order'
      };
    } else if (BigNumber.from(offer.extraParams).gt('0')) {
      return {
        isValid: false,
        reason: 'Offer has extra params'
      };
    } else if (BigNumber.from(listing.extraParams).gt('0')) {
      return {
        isValid: false,
        reason: 'Listing has extra params'
      };
    } else if (offer.execParams[0] !== listing.execParams[0]) {
      return {
        isValid: false,
        reason: 'Listing and offer have different currencies'
      };
    } else if (offer.execParams[1] !== listing.execParams[1]) {
      return {
        isValid: false,
        reason: 'Listing and offer have different complications'
      };
    } else if (!BigNumber.from(offer.constraints[0]).eq(listing.constraints[0])) {
      return {
        isValid: false,
        reason: 'Listing and offer have different num items'
      };
    } else if (!BigNumber.from(offer.constraints[0]).eq(1)) {
      return {
        isValid: false,
        reason: 'Orders with num items > 1 are not supported' // TODO support orders with more than 1 item
      };
    } else if (BigNumber.from(offer.constraints[1]).lt(listing.constraints[1])) {
      return {
        isValid: false,
        reason: 'Offer start price is less than listing start price' // TODO dynamic orders not supported
      };
    } else if (BigNumber.from(offer.constraints[3]).gt(targetBlock.timestamp)) {
      return {
        isValid: false,
        reason: 'Offer start time is in the future'
      };
    } else if (BigNumber.from(listing.constraints[3]).gt(targetBlock.timestamp)) {
      return {
        isValid: false,
        reason: 'Listing start time is in the future'
      };
    } else if (
      BigNumber.from(offer.constraints[4]).lt(targetBlock.timestamp) &&
      !BigNumber.from(offer.constraints[4]).eq(0)
    ) {
      return {
        isValid: false,
        reason: 'Offer end time is in the past'
      };
    } else if (
      BigNumber.from(listing.constraints[4]).lt(targetBlock.timestamp) &&
      !BigNumber.from(listing.constraints[4]).eq(0)
    ) {
      return {
        isValid: false,
        reason: 'Listing end time is in the past'
      };
    } else if (BigNumber.from(offer.constraints[6]).lt(targetBlock.gasPrice)) {
      return {
        isValid: false,
        reason: 'Offer gas price is too low'
      };
    }

    return {
      isValid: true,
      data: this._getExecutionInfo(offer, listing)
    };
  }

  protected _getExecutionInfo(offer: ChainOBOrder, listing: ChainOBOrder): NativeMatchExecutionInfo {
    const currency = listing.execParams[0];
    const wethAddress = Common.Addresses.Weth[parseInt(this._chainId, 10)];
    const isWeth = currency === wethAddress;

    let currencyTransfer: WethTransfer | EthTransfer;

    const value = BigNumber.from(listing.constraints[1]).lt(offer.constraints[1])
      ? BigNumber.from(listing.constraints[1])
      : BigNumber.from(offer.constraints[1]);
    if (isWeth) {
      currencyTransfer = {
        kind: TransferKind.WETH,
        contract: wethAddress,
        operator: getExchangeAddress(this._chainId),
        from: offer.signer,
        to: listing.signer,
        value: value.toString()
      };
    } else {
      currencyTransfer = {
        kind: TransferKind.ETH,
        from: offer.signer,
        to: listing.signer,
        value: value.toString()
      };
    }

    const erc721Transfers: Erc721Transfer[] = listing.nfts.flatMap(({ collection, tokens }) => {
      return tokens.map((token) => ({
        kind: TransferKind.ERC721,
        contract: collection,
        operator: getExchangeAddress(this._chainId),
        from: listing.signer,
        to: offer.signer,
        tokenId: token.tokenId
      }));
    });

    const orderNonces = {
      [listing.signer]: [listing.constraints[5].toString()],
      [offer.signer]: [offer.constraints[5].toString()]
    };

    const offerId = orderHash(offer);
    const listingId = orderHash(listing);

    const orderIds = [offerId, listingId];

    return {
      isNative: true,
      nativeExecutionTransfers: [currencyTransfer, ...erc721Transfers],
      orderNonces,
      orderIds
    };
  }
}
