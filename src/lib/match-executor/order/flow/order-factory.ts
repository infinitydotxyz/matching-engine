import { ethers } from 'ethers';

import { ChainId } from '@infinityxyz/lib/types/core';

import { OrderData } from '@/lib/orderbook/v1/types';

import { NonceProvider } from '../../nonce-provider/nonce-provider';
import { EndUserOrder } from './end-user-order';
import { MatchExecutorOrder } from './match-executor-order';
import { Order } from './order.abstract';

export class OrderFactory {
  constructor(
    protected _chainId: ChainId,
    protected _provider: ethers.providers.StaticJsonRpcProvider,
    protected _nonceProvider: NonceProvider,
    protected _matchExecutorAddress: string,
    protected _matchExecutorOwner: ethers.Wallet,
    protected _orderDurationSeconds: number
  ) {}

  public createOrder(params: OrderData) {
    if (Order.isMatchExecutorOrder(params)) {
      return new MatchExecutorOrder(
        params,
        this._chainId,
        this._provider,
        this._nonceProvider,
        this._matchExecutorAddress,
        this._matchExecutorOwner,
        this._orderDurationSeconds
      );
    }

    return new EndUserOrder(params, this._chainId, this._provider);
  }
}
