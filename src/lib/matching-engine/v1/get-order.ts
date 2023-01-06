import { constants } from 'ethers/lib/ethers';
import { parseUnits } from 'ethers/lib/utils';
import { nanoid } from 'nanoid';

import { ChainId, OrderSource, OrderStatus } from '@infinityxyz/lib/types/core';
import { chainConstants } from '@infinityxyz/lib/utils/constants';

import { config } from '@/config';
import { Order } from '@/lib/orderbook/v1';
import { OrderData } from '@/lib/orderbook/v1/types';

export type Kind = 'single-token' | 'single-collection';

export function getOrder(
  chainId: ChainId,
  priceEth: number,
  isSellOrder: boolean,
  kind: 'single-token',
  asset: { collection: string; tokenId: string }
): { orderData: OrderData; order: Order };
export function getOrder(
  chainId: ChainId,
  priceEth: number,
  isSellOrder: boolean,
  kind: 'single-collection',
  asset: { collection: string }
): { orderData: OrderData; order: Order };
export function getOrder(
  chainId: ChainId,
  priceEth: number,
  isSellOrder: boolean,
  kind: Kind,
  asset: { collection: string; tokenId?: string }
): { orderData: OrderData; order: Order } {
  const envConstants = chainConstants[chainId]['dev']['v2'];
  const currency = envConstants.wethAddress;
  const complication = envConstants.infinityContracts.obComplicationAddress;
  const id = nanoid();
  const chainOrder = {
    isSellOrder: isSellOrder,
    signer: constants.AddressZero,
    constraints: [
      1,
      parseUnits(`${priceEth}`, 'ether'),
      parseUnits(`${priceEth}`, 'ether'),
      Math.floor(Date.now() / 1000),
      Math.floor(Date.now() / 1000 + 60 * 60),
      0,
      0
    ],
    nfts: [
      {
        collection: asset.collection,
        tokens: asset.tokenId
          ? [
              {
                tokenId: asset.tokenId,
                numTokens: 1
              }
            ]
          : []
      }
    ],
    execParams: [currency, complication],
    extraParams: constants.HashZero,
    sig: ''
  };

  const data = {
    id,
    order: chainOrder,
    source: 'infinity' as OrderSource,
    sourceOrder: chainOrder,
    gasUsage: '0',
    status: 'active' as OrderStatus
  };

  const order = new Order(Order.getOrderParams(data.id, config.env.chainId, data.order));

  return { orderData: data, order };
}
