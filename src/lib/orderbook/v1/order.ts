import { BigNumber, constants } from 'ethers/lib/ethers';
import { formatEther, formatUnits } from 'ethers/lib/utils';

import { ChainId, ChainOBOrder } from '@infinityxyz/lib/types/core';

import { ErrorCode, OrderbookOrderError } from '../errors';
import { OrderParams } from './types';

export class Order {
  get id() {
    return this._params.id;
  }

  public get params(): OrderParams {
    return this._params;
  }

  public getOrderItem(): { collection: string } | { collection: string; tokenId: string } {
    const nfts = this._params.signedOrder.nfts;
    const collection = nfts[0];
    const token = collection.tokens[0];
    if (token) {
      return {
        collection: collection.collection,
        tokenId: token.tokenId
      };
    }

    return {
      collection: collection.collection
    };
  }

  constructor(protected _params: OrderParams) {}

  validate() {
    const nfts = this._params.signedOrder.nfts;

    if (this.params.numItems !== 1) {
      throw new OrderbookOrderError(this.id, ErrorCode.IncompatibleOrder, 'Num items must be 1');
    }

    if (nfts.length !== 1) {
      throw new OrderbookOrderError(this.id, ErrorCode.IncompatibleOrder, 'Num collections must be 1');
    }

    const collection = nfts[0];
    if (collection.tokens.length === 1 && collection.tokens[0].numTokens !== 1) {
      throw new OrderbookOrderError(this.id, ErrorCode.IncompatibleOrder, 'Token quantity must be 1');
    } else if (collection.tokens.length === 0 && this.params.side === 'sell') {
      throw new OrderbookOrderError(this.id, ErrorCode.IncompatibleOrder, 'Collection wide sell orders not supported');
    } else if (collection.tokens.length > 1) {
      throw new OrderbookOrderError(this.id, ErrorCode.IncompatibleOrder, 'Unsupported number of tokens');
    }

    if (this.params.startPriceWei !== this.params.endPriceWei) {
      throw new OrderbookOrderError(this.id, ErrorCode.IncompatibleOrder, 'Dynamic orders are not supported');
    }

    if (BigNumber.from(this.params.extraParams).toString() !== '0') {
      throw new OrderbookOrderError(this.id, ErrorCode.IncompatibleOrder, 'Invalid extra params');
    }
  }

  toJSON() {
    return {
      ...this._params
    };
  }

  toString() {
    return JSON.stringify(this.toJSON());
  }

  static fromString(str: string): Order | null {
    try {
      const params = JSON.parse(str) as OrderParams;
      return new Order(params);
    } catch (err) {
      return null;
    }
  }

  static getOrderParams(id: string, chainId: ChainId, signedOrder: ChainOBOrder): OrderParams {
    const constraints = signedOrder.constraints.map((item) => BigNumber.from(item));
    return {
      id,
      chainId,
      side: signedOrder.isSellOrder ? 'sell' : 'buy',
      signer: signedOrder.signer,
      numItems: constraints[0].toNumber(),
      startPriceWei: constraints[1].toString(),
      startPriceEth: parseFloat(formatEther(constraints[1].toString())),
      endPriceWei: constraints[2].toString(),
      endPriceEth: parseFloat(formatEther(constraints[2].toString())),
      startTime: constraints[3].toNumber(),
      endTime: constraints[4].toNumber(),
      startTimeMs: constraints[3].toNumber() * 1000,
      endTimeMs: constraints[4].toNumber() * 1000,
      nonce: constraints[5].toString(),
      maxTxGasPriceWei: constraints[6].toString(),
      maxTxGasPriceGwei: parseFloat(formatUnits(constraints[6].toString(), 'gwei')),
      currency: signedOrder.execParams[1],
      complication: signedOrder.execParams[0],
      extraParams: signedOrder.extraParams,
      isNative: signedOrder.signer !== constants.AddressZero,
      signedOrder
    };
  }
}
