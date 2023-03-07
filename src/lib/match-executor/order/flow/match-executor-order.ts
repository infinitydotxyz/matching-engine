import { BigNumberish, ethers } from 'ethers';

import { ChainId, ChainOBOrder } from '@infinityxyz/lib/types/core';
import { Flow } from '@reservoir0x/sdk';

import MatchExecutorAbi from '@/common/abi/match-executor.json';
import { OrderData } from '@/lib/orderbook/v1/types';

import { NonceProvider } from '../../nonce-provider/nonce-provider';
import { Order } from './order.abstract';

export class MatchExecutorOrder extends Order {
  _checkOrderKindValid(): void {
    return;
  }

  protected _contract: ethers.Contract;

  readonly isMatchExecutorOrder = true;

  protected nonce?: string;

  constructor(
    params: OrderData,
    _chainId: ChainId,
    _provider: ethers.providers.StaticJsonRpcProvider,
    protected _nonceProvider: NonceProvider,
    protected _matchExecutorAddress: string,
    protected _matchExecutorInitiator: ethers.Wallet,
    protected _orderDurationSeconds: number
  ) {
    super(params, _chainId, _provider);
    if (!Order.isMatchExecutorOrder(this._orderData)) {
      throw new Error('Order is not a match executor order');
    }
    this._contract = new ethers.Contract(
      this._matchExecutorAddress,
      MatchExecutorAbi,
      this._matchExecutorInitiator.provider
    );
    this._contract.connect(this._matchExecutorInitiator);
  }

  set startPrice(startPrice: BigNumberish) {
    this._params.constraints[1] = startPrice;
  }

  set endPrice(startPrice: BigNumberish) {
    this._params.constraints[2] = startPrice;
  }

  set startTime(startTime: number) {
    this._params.constraints[3] = startTime;
  }

  set endTime(endTime: number) {
    this._params.constraints[4] = endTime;
  }

  set currency(currency: string) {
    this._params.execParams[1] = currency;
  }

  set complication(complication: string) {
    this._params.execParams[0] = complication;
  }

  protected _matchOrder(data: Pick<ChainOBOrder, 'constraints' | 'execParams'>, currentBlockTimestamp: number) {
    const { constraints, execParams } = data;
    const [, startPrice, endPrice] = constraints;

    const [complication, currency] = execParams;

    this.startPrice = startPrice;
    this.endPrice = endPrice;
    this.startTime = currentBlockTimestamp;
    this.endTime = currentBlockTimestamp + this._orderDurationSeconds;

    this.currency = currency;
    this.complication = complication;
  }

  async getChainOrder(opposingOrder: ChainOBOrder, currentBlockTimestamp: number) {
    this._matchOrder(opposingOrder, currentBlockTimestamp);
    return await this._signOrder(this._params);
  }

  protected async _signOrder(_unsignedOrder: ChainOBOrder) {
    const chainId = parseInt(this._chainId, 10);
    const unsignedOrder = new Flow.Order(chainId, {
      ..._unsignedOrder,
      constraints: _unsignedOrder.constraints.map((c) => c.toString())
    });

    /**
     * only get a nonce if it hasn't been set yet
     */
    const nonce = this.nonce ?? (await this._nonceProvider.getNonce()).toString();
    this.nonce = nonce;

    unsignedOrder.signer = this._contract.address;
    unsignedOrder.nonce = nonce.toString();
    unsignedOrder.maxGasPrice = '0';

    await unsignedOrder.sign(this._matchExecutorInitiator, true);
    const signedOrder = unsignedOrder.getSignedOrder();

    return signedOrder;
  }
}
