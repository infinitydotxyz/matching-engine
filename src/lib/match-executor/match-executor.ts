import { BigNumberish, constants, ethers } from 'ethers';
import { defaultAbiCoder, splitSignature } from 'ethers/lib/utils';

import { ChainId, ChainOBOrder } from '@infinityxyz/lib/types/core';
import * as Sdk from '@reservoir0x/sdk';

import MatchExecutorAbi from '@/common/abi/match-executor.json';
import { logger } from '@/common/logger';

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
    let isNative = data.batches.length === 1;
    for (const batch of data.batches) {
      if (batch.externalFulfillments.calls.length > 0) {
        isNative = false;
      }
      batch.matches = batch.matches.map((match) => {
        for (let i = 0; i < match.buys.length; i += 1) {
          const buy = match.buys[i];
          const sell = match.sells[i];
          if (buy.constraints[0] !== sell.constraints[0]) {
            throw new Error('Buy and sell constraints do not match');
          } else if (buy.execParams[0] !== sell.execParams[0]) {
            throw new Error("Complications don't match");
          } else if (buy.execParams[1] !== sell.execParams[1]) {
            throw new Error("Currencies don't match");
          }
        }

        if (match.constructs.length === 0) {
          return {
            buys: match.buys,
            sells: match.sells,
            matchType: match.matchType,
            constructs: match.sells.map((item) => item.nfts)
          };
        }
        return match;
      });
    }

    logger.log('match-executor', `Batches ${JSON.stringify(data.batches, null, 2)}`);

    const encoded = isNative
      ? this._contract.interface.encodeFunctionData('executeNativeMatches', [data.batches[0].matches])
      : this._contract.interface.encodeFunctionData('executeBrokerMatches', [data.batches]);

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
      logger.log('match-executor', `Executing match: ${match.matchId} Is Native: ${match.isNative}`);
      if (match.isNative) {
        const listing = match.listing;
        const offer = match.offer;

        if (listing.source !== 'infinity' || offer.source !== 'infinity') {
          throw new Error('Expected native orders');
        }
        const matchOrders = await this._getMatch({ listing: match.listing, offer: match.offer });

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

        // TODO check start/end price, is sell order, currency, complication
        const matchOrders = await this._getMatch({ listing: match.listing, offer: match.offer });

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
    const buy = orderMatch.offer.order;
    let sell = orderMatch.listing.order;

    const matchType = this._getMatchType(buy, sell);

    const constructs = matchType === MatchOrdersType.OneToOneSpecific ? [] : [sell.nfts];

    if (sell.signer === constants.AddressZero) {
      // TODO adjust price, start time/end time, currency
      // TODO we should validate orders after this

      const [numItems, , , , , nonce, maxGasPrice] = sell.constraints;
      const intermediateOrder = new Sdk.Infinity.Order(this.chain, {
        ...sell,
        constraints: sell.constraints.map((item) => item.toString())
      });
      const res = await this._signOrder(intermediateOrder);
      sell = res.signedOrder;
    }

    return {
      buys: [buy],
      sells: [sell],
      constructs,
      matchType
    };
  }

  private nonce = 1; // TODO load nonce from db
  protected async _getNonce() {
    this.nonce += 1;
    return Promise.resolve(this.nonce.toString());
  }

  protected async _signOrder(unsignedOrder: Sdk.Infinity.Order) {
    const nonce = await this._getNonce();
    if (!unsignedOrder.isSellOrder) {
      throw new Error('Native match executor offers are not yet supported');
    }

    unsignedOrder.signer = this._contract.address; // TODO will this cause an error?
    unsignedOrder.nonce = nonce; // TODO
    unsignedOrder.maxGasPrice = '0';

    const intermediateOrderHash = unsignedOrder.hash();
    const { types, value, domain } = unsignedOrder.getSignatureData();
    const signature = splitSignature(await this._intermediary._signTypedData(domain, types, value));

    const encodedSig = defaultAbiCoder.encode(['bytes32', 'bytes32', 'uint8'], [signature.r, signature.s, signature.v]);

    const signedIntermediateOrder: Sdk.Infinity.Types.SignedOrder = {
      ...value,
      sig: encodedSig
    };

    return { signedOrder: signedIntermediateOrder, hash: intermediateOrderHash };
  }

  protected _getMatchType(listingOrder: ChainOBOrder, offerOrder: ChainOBOrder): MatchOrdersType {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { sig: _sig, ...listingParams } = listingOrder;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { sig: _offerSig, ...offerParams } = offerOrder;
    const listing = new Sdk.Infinity.Order(this.chain, {
      ...listingParams,
      constraints: listingParams.constraints.map((item) => item.toString())
    });
    const offer = new Sdk.Infinity.Order(this.chain, {
      ...offerParams,
      constraints: offerParams.constraints.map((item) => item.toString())
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
