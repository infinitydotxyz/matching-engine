import { BigNumberish, constants, ethers } from 'ethers';

import { ChainId, ChainNFTs, ChainOBOrder } from '@infinityxyz/lib/types/core';
import * as Sdk from '@reservoir0x/sdk';

import MatchExecutorAbi from '@/common/abi/match-executor.json';

import { OrderData } from '../orderbook/v1/types';
import { Match } from './match/types';
import { Batch, Call, ExternalFulfillments, MatchOrders, MatchOrdersType } from './types';

export class MatchExecutor {
  protected get chain() {
    return parseInt(this._chainId, 10);
  }

  protected _contract: ethers.Contract;

  constructor(protected _chainId: ChainId, protected _address: string, protected _intermediary: ethers.Wallet) {
    this._contract = new ethers.Contract(this._address, MatchExecutorAbi, this._intermediary);
  }

  getTxn(data: {
    batches: Batch[];
    maxFeePerGas: BigNumberish;
    maxPriorityFeePerGas: BigNumberish;
    gasLimit: BigNumberish;
  }) {
    const encoded = this._contract.interface.encodeFunctionData('executeBrokerMatches', [data.batches]);

    const txn = {
      from: this._intermediary.address,
      to: this._address,
      maxFeePerGas: data.maxFeePerGas.toString(),
      maxPriorityFeePerGas: data.maxPriorityFeePerGas.toString(),
      gasLimit: data.gasLimit.toString(),
      data: encoded
    };

    return {
      txn
    };
  }

  async executeMatchesTxn(orderMatches: Match[]): Promise<{ batches: Batch[] }> {
    const externalFulfillments: ExternalFulfillments = {
      calls: [],
      nftsToTransfer: []
    };
    const matches: MatchOrders[] = [];

    for (const match of orderMatches) {
      if (match.isNative) {
        const listing = match.listing;
        const offer = match.offer;

        if (listing.source !== 'infinity' || offer.source !== 'infinity') {
          throw new Error('Expected native orders');
        }

        const listingOrder = new Sdk.Infinity.Order(this.chain, listing.sourceOrder as Sdk.Infinity.Types.SignedOrder);

        const offerOrder = new Sdk.Infinity.Order(this.chain, offer.sourceOrder as Sdk.Infinity.Types.SignedOrder);

        const type = this._getMatchType(listingOrder.getSignedOrder(), offerOrder.getSignedOrder());
        let orderConstructs: ChainNFTs[] = [];
        if (type === MatchOrdersType.OneToOneUnspecific) {
          orderConstructs = listingOrder.params.nfts;
        } else if (type === MatchOrdersType.OneToMany) {
          throw new Error('One to many orders are not yet supported');
        }

        const matchOrders: MatchOrders = {
          buys: [offerOrder.getSignedOrder()],
          sells: [listingOrder.getSignedOrder()],
          constructs: [orderConstructs],
          matchType: type
        };

        matches.push(matchOrders);
      } else {
        if (match.listing.source === 'infinity') {
          throw new Error('Expected listing to be non-native');
        } else if (match.offer.source !== 'infinity') {
          throw new Error('Expected offer to be native');
        }

        const listing = new Sdk.Seaport.Order(
          this.chain,
          match.listing.sourceOrder as Sdk.Seaport.Types.OrderComponents
        );

        const matchParams = listing.buildMatching();
        const seaportExchange = new Sdk.Seaport.Exchange(this.chain);

        const txnData = seaportExchange.fillOrderTx(this._address, listing, matchParams);

        const call: Call = {
          data: txnData.data,
          value: txnData.value ?? '0',
          to: txnData.to,
          isPayable: txnData.value !== undefined && txnData.value !== '0'
        };

        const nftsToTransfer = match.listing.order.nfts;

        const intermediateOrder = new Sdk.Infinity.Order(
          this.chain,
          match.listing.order as Sdk.Infinity.Types.SignedOrder
        );

        intermediateOrder.signer = this._intermediary.address;
        intermediateOrder.nonce = '1'; // TODO
        intermediateOrder.maxGasPrice = '0';

        await intermediateOrder.sign(this._intermediary);

        const offerOrder = new Sdk.Infinity.Order(
          this.chain,
          match.offer.sourceOrder as Sdk.Infinity.Types.SignedOrder
        );
        const type = this._getMatchType(intermediateOrder.getSignedOrder(), offerOrder.getSignedOrder());
        let orderConstructs: ChainNFTs[] = [];
        if (type === MatchOrdersType.OneToOneUnspecific) {
          orderConstructs = intermediateOrder.params.nfts;
        } else if (type === MatchOrdersType.OneToMany) {
          throw new Error('One to many orders are not yet supported');
        }
        // TODO check start/end price, is sell order, currency, complication

        const matchOrders: MatchOrders = {
          buys: [match.offer.order],
          sells: [intermediateOrder.getSignedOrder()],
          constructs: [orderConstructs],
          matchType: type
        };

        externalFulfillments.calls.push(call);
        externalFulfillments.nftsToTransfer.push(...nftsToTransfer);
        matches.push(matchOrders);
      }
    }

    return {
      batches: [
        {
          externalFulfillments,
          matches
        }
      ]
    };
  }

  protected async _getMatch(orderMatch: { listing: OrderData; offer: OrderData }): Promise<MatchOrders> {
    let buy = orderMatch.offer.order;
    const sell = orderMatch.listing.order;

    const matchType = this._getMatchType(buy, sell);

    const constructs = matchType === MatchOrdersType.OneToOneSpecific ? [] : [buy.nfts];

    if (buy.signer === constants.AddressZero) {
      // nonce, gas price, signer + sign
      buy = await this._signOrder(buy);
    }

    return {
      buys: [buy],
      sells: [sell],
      constructs,
      matchType
    };
  }

  protected async _getNonce() {
    return Promise.resolve('1'); // TODO
  }

  protected async _signOrder(chainOrder: ChainOBOrder) {
    const nonce = await this._getNonce();

    if (!chainOrder.isSellOrder) {
      throw new Error('Native match executor offers are not yet supported');
    }

    const order = new Sdk.Infinity.Order(this.chain, {
      ...chainOrder,
      constraints: chainOrder.constraints.map((item) => item.toString())
    });

    order.signer = this._address;
    order.nonce = nonce;
    order.maxGasPrice = '0';

    await order.sign(this._intermediary);

    return order.getSignedOrder();
  }

  protected _getMatchType(listingOrder: ChainOBOrder, offerOrder: ChainOBOrder): MatchOrdersType {
    const listing = new Sdk.Infinity.Order(this.chain, {
      ...listingOrder,
      constraints: listingOrder.constraints.map((item) => item.toString())
    });
    const offer = new Sdk.Infinity.Order(this.chain, {
      ...offerOrder,
      constraints: offerOrder.constraints.map((item) => item.toString())
    });

    switch (offer.kind) {
      case 'single-token':
        return MatchOrdersType.OneToOneSpecific;
      case 'contract-wide':
        return listing.kind === 'single-token' ? MatchOrdersType.OneToOneUnspecific : MatchOrdersType.OneToMany;
      case 'complex':
        return MatchOrdersType.OneToMany;
    }
  }
}
