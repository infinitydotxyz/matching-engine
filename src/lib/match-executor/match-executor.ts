import { BigNumberish, constants, ethers } from 'ethers';
import { defaultAbiCoder, parseUnits, splitSignature } from 'ethers/lib/utils';

import { InfinityOBComplicationABI } from '@infinityxyz/lib/abi';
import { ChainId, ChainNFTs, ChainOBOrder } from '@infinityxyz/lib/types/core';
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

      for (const match of batch.matches) {
        // const type = match.matchType;
        for (let i = 0; i < match.buys.length; i += 1) {
          const buy = match.buys[i];
          const sell = match.sells[i];
          // const constructs = match.constructs;

          if (buy.constraints[0] !== sell.constraints[0]) {
            throw new Error('Buy and sell constraints do not match');
          } else if (buy.execParams[0] !== sell.execParams[0]) {
            throw new Error("Complications don't match");
          } else if (buy.execParams[1] !== sell.execParams[1]) {
            throw new Error("Currencies don't match");
          }
        }
      }
    }

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

        intermediateOrder.signer = this._contract.address; // TODO will this cause an error?
        intermediateOrder.nonce = '2'; // TODO
        intermediateOrder.maxGasPrice = parseUnits('100', 'gwei').toString(); // TODO

        const intermediateOrderHash = intermediateOrder.hash();
        const { types, value, domain } = intermediateOrder.getSignatureData();
        const signature = splitSignature(await this._intermediary._signTypedData(domain, types, value));

        const encodedSig = defaultAbiCoder.encode(
          ['bytes32', 'bytes32', 'uint8'],
          [signature.r, signature.s, signature.v]
        );

        const signedIntermediateOrder: Sdk.Infinity.Types.SignedOrder = {
          ...value,
          sig: encodedSig
        };

        const offerOrder = new Sdk.Infinity.Order(
          this.chain,
          match.offer.sourceOrder as Sdk.Infinity.Types.SignedOrder
        );
        const type = this._getMatchType(signedIntermediateOrder, offerOrder.getSignedOrder());
        let orderConstructs: ChainNFTs[] = [];
        if (type === MatchOrdersType.OneToOneUnspecific) {
          orderConstructs = signedIntermediateOrder.nfts;
        } else if (type === MatchOrdersType.OneToMany) {
          throw new Error('One to many orders are not yet supported');
        }
        // TODO check start/end price, is sell order, currency, complication

        const buyHash = offerOrder.hash();
        const sellHash = intermediateOrderHash;
        const matchOrders: MatchOrders = {
          buys: [offerOrder.getSignedOrder()],
          sells: [signedIntermediateOrder],
          constructs: [orderConstructs],
          matchType: type
        };

        const complication = new ethers.Contract(
          match.offer.order.execParams[0],
          InfinityOBComplicationABI,
          this._intermediary.provider
        );

        const isBuyValid = await complication.isOrderValid(matchOrders.buys[0], buyHash);
        logger.log('match-executor', `Is buy valid: ${isBuyValid}`);
        const isSellValid = await complication.isOrderValid(matchOrders.sells[0], sellHash);
        logger.log('match-executor', `Is sell valid: ${isSellValid}`);

        const canExec = await complication.canExecMatchOrder(
          matchOrders.sells[0],
          matchOrders.buys[0],
          matchOrders.constructs[0]
        );
        logger.log('match-executor', `Can exec: ${canExec}`);

        const canExecOne = await complication.canExecMatchOneToOne(matchOrders.sells[0], matchOrders.buys[0]);
        logger.log('match-executor', `Can exec one: ${canExecOne}`);

        const isVerified = await complication.verifyMatchOrders(
          sellHash,
          buyHash,
          matchOrders.sells[0],
          matchOrders.buys[0]
        );

        logger.log('match-executor', `Is verified: ${isVerified}`);

        const verifyOne = await complication.verifyMatchOneToOneOrders(
          sellHash,
          buyHash,
          matchOrders.sells[0],
          matchOrders.buys[0]
        );

        logger.log('match-executor', `Is verified one: ${verifyOne}`);

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
      // TODO adjust price, start time/end time, currency
      const intermediateOrder = new Sdk.Infinity.Order(this.chain, {
        ...buy,
        constraints: buy.constraints.map((item) => item.toString())
      });
      const res = await this._signOrder(intermediateOrder);
      buy = res.signedOrder;
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
