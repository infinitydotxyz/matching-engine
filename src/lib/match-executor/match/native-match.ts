import { BigNumber } from 'ethers';

import { ChainId, ChainOBOrder } from '@infinityxyz/lib/types/core';
import { getExchangeAddress, orderHash } from '@infinityxyz/lib/utils';
import { Common } from '@reservoir0x/sdk';

import { Block, BlockWithMaxFeePerGas } from '@/common/block';
import { ValidityResult, ValidityResultWithData } from '@/lib/utils/validity-result';

import * as Flow from '../order/flow';
import { Erc721Transfer, EthTransfer, TransferKind, WethTransfer } from '../simulator/types';
import { MatchOrders, MatchOrdersType } from '../types';
import { OrderMatch } from './order-match.abstract';
import { Match, NativeMatchExecutionInfo } from './types';

export class NativeMatch extends OrderMatch {
  protected _listing: Flow.MatchExecutorOrder | Flow.EndUserOrder;
  protected _offer: Flow.MatchExecutorOrder | Flow.EndUserOrder;

  constructor(match: Match, protected _chainId: ChainId, orderFactory: Flow.OrderFactory) {
    super(match);
    this._listing = orderFactory.createOrder(match.listing);
    this._offer = orderFactory.createOrder(match.offer);
  }

  async prepare(params: { taker: string }): Promise<ValidityResult> {
    const [listingResult, offerResult] = await Promise.all([
      this._listing.prepareOrder(params),
      this._offer.prepareOrder(params)
    ]);

    if (!listingResult.isValid) {
      return listingResult;
    } else if (!offerResult.isValid) {
      return offerResult;
    }
    return {
      isValid: true
    };
  }

  async getMatchOrders(currentBlockTimestamp: number): Promise<MatchOrders> {
    const offer = await this._offer.getChainOrder(this._listing.params, currentBlockTimestamp);
    const listing = await this._listing.getChainOrder(this._offer.params, currentBlockTimestamp);

    const matchType =
      this._offer.nfts[0].tokens.length === 0 ? MatchOrdersType.OneToOneUnspecific : MatchOrdersType.OneToOneSpecific;

    const constructs = matchType === MatchOrdersType.OneToOneUnspecific ? listing.nfts : [];

    const matchOrders: MatchOrders = {
      buys: [offer],
      sells: [listing],
      constructs: [constructs],
      matchType
    };

    return matchOrders;
  }

  async verifyMatchAtTarget(
    targetBlock: BlockWithMaxFeePerGas,
    currentBlock: Block
  ): Promise<ValidityResultWithData<{ native: NativeMatchExecutionInfo }>> {
    if (this._listing.isMatchExecutorOrder && this._offer.isMatchExecutorOrder) {
      return {
        isValid: false,
        reason: 'Listing and offer are both match executor orders',
        isTransient: false
      };
    }

    const offer = await this._offer.getChainOrder(this._listing.params, currentBlock.timestamp);
    const listing = await this._listing.getChainOrder(this._offer.params, currentBlock.timestamp);

    const nativeLike = [
      Common.Addresses.Eth[parseInt(this._chainId, 10)],
      Common.Addresses.Weth[parseInt(this._chainId, 10)]
    ];

    if (offer.signer === listing.signer) {
      return {
        isValid: false,
        reason: 'Listing and offer have the same signer',
        isTransient: false
      };
    } else if (!offer.sig) {
      return {
        isValid: false,
        reason: 'Offer signature is missing',
        isTransient: false
      };
    } else if (!listing.sig) {
      return {
        isValid: false,
        reason: 'Listing signature is missing',
        isTransient: false
      };
    } else if (offer.isSellOrder) {
      return {
        isValid: false,
        reason: 'Offer is a sell order',
        isTransient: false
      };
    } else if (!listing.isSellOrder) {
      return {
        isValid: false,
        reason: 'Listing is not a sell order',
        isTransient: false
      };
    } else if (BigNumber.from(offer.extraParams).gt('0')) {
      return {
        isValid: false,
        reason: 'Offer has extra params',
        isTransient: false
      };
    } else if (BigNumber.from(listing.extraParams).gt('0')) {
      return {
        isValid: false,
        reason: 'Listing has extra params',
        isTransient: false
      };
    } else if (
      offer.execParams[1] !== listing.execParams[1] &&
      !(nativeLike.includes(offer.execParams[1]) && nativeLike.includes(listing.execParams[1]))
    ) {
      return {
        isValid: false,
        reason: 'Listing and offer have different currencies',
        isTransient: false
      };
    } else if (offer.execParams[0] !== listing.execParams[0]) {
      return {
        isValid: false,
        reason: 'Listing and offer have different complications',
        isTransient: false
      };
    } else if (!BigNumber.from(offer.constraints[0]).eq(listing.constraints[0])) {
      return {
        isValid: false,
        reason: 'Listing and offer have different num items',
        isTransient: false
      };
    } else if (!BigNumber.from(offer.constraints[0]).eq(1)) {
      return {
        isValid: false,
        reason: 'Orders with num items > 1 are not supported', // future-todo: support orders with more than 1 item
        isTransient: false
      };
    } else if (BigNumber.from(offer.constraints[1]).lt(listing.constraints[1])) {
      return {
        isValid: false,
        reason: 'Offer start price is less than listing start price', // future-todo: dynamic orders not supported
        isTransient: false
      };
    } else if (BigNumber.from(offer.constraints[3]).gt(targetBlock.timestamp)) {
      return {
        isValid: false,
        reason: 'Offer start time is in the future',
        isTransient: true
      };
    } else if (BigNumber.from(listing.constraints[3]).gt(targetBlock.timestamp)) {
      return {
        isValid: false,
        reason: 'Listing start time is in the future',
        isTransient: true
      };
    } else if (
      BigNumber.from(offer.constraints[4]).lt(targetBlock.timestamp) &&
      !BigNumber.from(offer.constraints[4]).eq(0)
    ) {
      return {
        isValid: false,
        reason: 'Offer end time is in the past',
        isTransient: false
      };
    } else if (
      BigNumber.from(listing.constraints[4]).lt(targetBlock.timestamp) &&
      !BigNumber.from(listing.constraints[4]).eq(0)
    ) {
      return {
        isValid: false,
        reason: 'Listing end time is in the past',
        isTransient: false
      };
    } else if (BigNumber.from(offer.constraints[6]).lt(targetBlock.maxFeePerGas)) {
      return {
        isValid: false,
        reason: 'Offer gas price is too low',
        isTransient: true
      };
    }

    return {
      isValid: true,
      data: {
        native: this._getExecutionInfo(offer, listing, targetBlock)
      }
    };
  }

  protected _getExecutionInfo(
    offer: ChainOBOrder,
    listing: ChainOBOrder,
    targetBlock: BlockWithMaxFeePerGas
  ): NativeMatchExecutionInfo {
    const currency = offer.execParams[1];
    const wethAddress = Common.Addresses.Weth[parseInt(this._chainId, 10)];
    const isWeth = currency === wethAddress;

    const exchange = getExchangeAddress(this._chainId);
    let currencyTransfer: WethTransfer | EthTransfer;

    const gasUsage = 300_000; // TODO improve this calculation
    const gasCost = BigNumber.from(gasUsage).mul(targetBlock.maxFeePerGas);
    const refund: WethTransfer = {
      kind: TransferKind.WETH,
      contract: wethAddress,
      operator: exchange,
      from: offer.signer,
      to: exchange,
      value: gasCost
    };

    const value = BigNumber.from(listing.constraints[1]).lt(offer.constraints[1])
      ? BigNumber.from(listing.constraints[1])
      : BigNumber.from(offer.constraints[1]);
    if (isWeth) {
      currencyTransfer = {
        kind: TransferKind.WETH,
        contract: wethAddress,
        operator: exchange,
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
      nativeExecutionTransfers: [currencyTransfer, refund, ...erc721Transfers],
      orderNonces,
      orderIds
    };
  }
}
