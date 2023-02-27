import { BigNumber, BigNumberish, constants, ethers } from 'ethers';

import { ChainOBOrder, OrderSource } from '@infinityxyz/lib/types/core';
import { getOBComplicationAddress } from '@infinityxyz/lib/utils';

import { OrderData } from '@/lib/orderbook/v1/types';
import { ValidityResult } from '@/lib/utils/validity-result';

import { ErrorCode } from '../errors/error-code';
import { OrderError } from '../errors/order-error';
import { SourceOrder } from '../source-order';

export abstract class Order extends SourceOrder<ChainOBOrder> {
  static isMatchExecutorOrder(orderData: OrderData) {
    return orderData.source !== 'flow' || orderData.order.signer === constants.AddressZero;
  }

  public source: OrderSource = 'flow';

  abstract readonly isMatchExecutorOrder: boolean;

  public get params() {
    return this._params;
  }

  get maker() {
    return this._params.signer;
  }

  get startTime() {
    return parseInt(this._params.constraints[3].toString(), 10);
  }

  get endTime() {
    return parseInt(this._params.constraints[4].toString(), 10);
  }

  get startPrice() {
    return this._params.constraints[1];
  }

  get endPrice() {
    return this._params.constraints[2];
  }

  get currency() {
    return this._params.execParams[1];
  }

  get nfts() {
    return this._params.nfts;
  }

  get numItems() {
    return parseInt(this._params.constraints[0].toString(), 10);
  }

  public get isERC721() {
    return true;
  }

  public get isPrivate() {
    if (this._params.extraParams !== constants.AddressZero && this._params.extraParams !== constants.HashZero) {
      return ethers.utils.isAddress(this._params.extraParams);
    }
    return false;
  }

  public get isSellOrder() {
    return this._params.isSellOrder;
  }

  public get complication() {
    return this._params.execParams[0];
  }

  public get maxGasPrice() {
    return this._params.constraints[6];
  }

  protected _checkValid() {
    if (!this._params.sig && this.maker !== constants.AddressZero) {
      throw new OrderError('order not signed', ErrorCode.NotSigned, '', 'flow', 'unsupported');
    }
    const complication = getOBComplicationAddress(this._chainId);

    if (complication === constants.AddressZero || this.complication !== complication) {
      throw new OrderError(
        'invalid complication',
        ErrorCode.FlowComplication,
        this._params.execParams[0],
        'flow',
        'unsupported'
      );
    }

    this._checkOrderKindValid();
  }

  abstract _checkOrderKindValid(): void;

  public abstract getChainOrder(
    opposingOrder: ChainOBOrder,
    currentBlockTimestamp: number
  ): Promise<ChainOBOrder> | ChainOBOrder;

  public isValidAtTarget(targetBlock: {
    timestamp: number;
    blockNumber: number;
    gasPrice: BigNumberish;
  }): Promise<ValidityResult> {
    const isTimeValid =
      this.endTime === 0 || (targetBlock.timestamp > this.startTime && targetBlock.timestamp < this.endTime);

    const isGasPriceValid = this.isSellOrder || BigNumber.from(this.maxGasPrice).gte(targetBlock.gasPrice);

    if (!isTimeValid) {
      return Promise.resolve({
        isValid: false,
        reason: 'Order times are not valid at the target block',
        isTransient: true
      });
    } else if (!isGasPriceValid) {
      return Promise.resolve({
        isValid: false,
        reason: 'Order gas price is not valid at the target block',
        isTransient: true
      });
    }

    return Promise.resolve({
      isValid: true
    });
  }
}
