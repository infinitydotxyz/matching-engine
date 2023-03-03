import { ethers } from 'ethers';

import { ChainId } from '@infinityxyz/lib/types/core';
import { Seaport, SeaportV14 } from '@reservoir0x/sdk';

import { OrderData } from '@/lib/orderbook/v1/types';

import { config } from './config';
import { ErrorCode } from './errors/error-code';
import { OrderError } from './errors/order-error';

export class NonNativeOrderFactory {
  get chainId() {
    return parseInt(this._chainId, 10);
  }

  constructor(protected _chainId: ChainId, protected _provider: ethers.providers.StaticJsonRpcProvider) {}

  create(orderData: OrderData) {
    switch (orderData.source) {
      case 'seaport': {
        const order = new Seaport.Order(this.chainId, orderData.sourceOrder as Seaport.Types.OrderComponents);
        const marketplaceConfig = config[orderData.source];
        const kindConfig = marketplaceConfig?.kinds?.[order.params.kind as keyof typeof marketplaceConfig.kinds];
        if (!kindConfig) {
          throw new OrderError(
            `Order source not found`,
            ErrorCode.OrderSource,
            orderData.source,
            orderData.source,
            'unexpected'
          );
        }

        if (!kindConfig.enabled || !('order' in kindConfig)) {
          throw new OrderError(
            `Order source not enabled`,
            ErrorCode.OrderSource,
            orderData.source,
            orderData.source,
            'unsupported'
          );
        }

        return new kindConfig.order(orderData, this._chainId, this._provider);
      }

      case 'seaport-v1.4': {
        const order = new SeaportV14.Order(this.chainId, orderData.sourceOrder as SeaportV14.Types.OrderComponents);
        const marketplaceConfig = config[orderData.source];
        const kindConfig = marketplaceConfig?.kinds?.[order.params.kind as keyof typeof marketplaceConfig.kinds];
        if (!kindConfig) {
          throw new OrderError(
            `Order source not found`,
            ErrorCode.OrderSource,
            orderData.source,
            orderData.source,
            'unexpected'
          );
        }

        if (!kindConfig.enabled || !('order' in kindConfig)) {
          throw new OrderError(
            `Order source not enabled`,
            ErrorCode.OrderSource,
            orderData.source,
            orderData.source,
            'unsupported'
          );
        }

        return new kindConfig.order(orderData, this._chainId, this._provider);
      }

      default: {
        throw new OrderError(
          `Order source not enabled`,
          ErrorCode.OrderSource,
          orderData.source,
          orderData.source,
          'unsupported'
        );
      }
    }
  }
}
