import { BigNumberish, constants, ethers } from 'ethers';

import { ChainId, ChainNFTs, OrderSource } from '@infinityxyz/lib/types/core';
import * as Sdk from '@reservoir0x/sdk';

import { OrderData } from '@/lib/orderbook/v1/types';

import { ErrorCode } from './errors/error-code';
import { OrderCurrencyError, OrderDynamicError, OrderError, OrderSideError } from './errors/order-error';

export abstract class SourceOrder<RawOrder = never> {
  get chainId(): number {
    return parseInt(this._chainId, 10);
  }

  abstract readonly source: OrderSource;

  protected _params: RawOrder;

  protected eth: string;
  protected weth: string;
  constructor(
    protected _orderData: OrderData,
    protected _chainId: ChainId,
    protected _provider: ethers.providers.JsonRpcProvider
  ) {
    this._params = this._orderData.sourceOrder as RawOrder;
    this.eth = Sdk.Common.Addresses.Eth[this.chainId];
    this.weth = Sdk.Common.Addresses.Weth[this.chainId];
  }

  abstract get maker(): string;

  abstract get startTime(): number;
  abstract get endTime(): number;

  abstract get startPrice(): BigNumberish;
  abstract get endPrice(): BigNumberish;

  abstract get currency(): string;

  abstract get nfts(): ChainNFTs[];

  abstract get numItems(): number;

  abstract get isPrivate(): boolean;

  abstract get isERC721(): boolean;

  protected abstract _checkValid(): void;

  abstract get isSellOrder(): boolean;

  protected _baseCheck() {
    if (this.source !== 'infinity') {
      /**
       * only sell orders are supported
       */
      if (!this.isSellOrder) {
        throw new OrderSideError(this.isSellOrder, this.source, 'unsupported');
      }

      /**
       * only open orders are supported
       */
      if (this.isPrivate) {
        throw new OrderError('private order', ErrorCode.OrderPrivate, `true`, this.source);
      }

      /**
       * only ERC721 tokens are supported
       */
      if (!this.isERC721) {
        throw new OrderError('non-erc721 order', ErrorCode.OrderTokenStandard, `true`, this.source);
      }

      const supportedCurrencies = [this.eth, this.weth];
      if (!supportedCurrencies.includes(this.currency)) {
        throw new OrderCurrencyError(this.source, this.currency);
      }
    }

    if (this.maker === constants.AddressZero) {
      throw new OrderError('invalid signer', ErrorCode.Signer, this.maker, this.source, 'unsupported');
    }

    /**
     * only static orders are supported
     */
    if (this.startPrice.toString() !== this.endPrice.toString()) {
      throw new OrderDynamicError(this.source);
    }

    if (this.numItems !== 1) {
      throw new OrderError(
        'only single item orders are supported',
        ErrorCode.OrderTokenQuantity,
        this.numItems?.toString?.(),
        this.source,
        'unsupported'
      );
    }
  }

  protected checkValid() {
    this._baseCheck();
    this._checkValid();
  }
}
