import { ethers } from 'ethers';
import { parseEther, parseUnits } from 'ethers/lib/utils';

import { ChainId } from '@infinityxyz/lib/types/core';
import { Infinity, Common, Seaport } from '@reservoir0x/sdk';

import { JobData } from '@/lib/order-relay/v1/order-relay';

import { logger } from './common/logger';
import { getNetworkConfig } from './config';

export async function createMatch(chainId: ChainId) {
  const matches: { seaportJob: JobData; infinityJob: JobData }[] = [];
  const network = await getNetworkConfig(chainId);
  const chainIdInt = parseInt(chainId, 10);
  const gwei = parseUnits('1', 'gwei');

  if (!('test' in network) || !network.test) {
    throw new Error('invalid network config');
  }
  const seaportExchange = new Seaport.Exchange(chainIdInt);
  const seller = network.test.erc721Owner;
  const txn = await network.test.erc721.approve(seller.connect(network.httpProvider), seaportExchange.contract.address);

  const receipt = await txn.wait();
  if (receipt.status !== 1) {
    throw new Error('Failed to approve');
  }

  const time = (await network.httpProvider.getBlock('latest')).timestamp;

  for (let tokenId = 1; tokenId < 10; tokenId += 1) {
    try {
      const seaportBuilder = new Seaport.Builders.SingleToken(chainIdInt);

      const seaportParams = {
        side: 'sell',
        tokenKind: 'erc721',
        offerer: seller.address,
        contract: network.test.erc721.contract.address,
        tokenId: tokenId.toString(),
        paymentToken: Common.Addresses.Eth[chainIdInt],
        price: parseEther('0.001'),
        counter: 0,
        startTime: time,
        endTime: time + 3600
      };
      const seaportSellOrder = seaportBuilder.build(seaportParams as Parameters<typeof seaportBuilder.build>[0]);
      await seaportSellOrder.sign(seller);

      const orderBuilder = new Infinity.Builders.SingleToken(chainIdInt);

      const correspondingOrder = new Infinity.Builders.SingleToken(chainIdInt).build({
        isSellOrder: true,
        tokenId: tokenId.toString(),
        collection: network.test.erc721.contract.address,
        numTokens: 1,
        signer: ethers.constants.AddressZero,
        nonce: tokenId.toString(),
        maxGasPrice: gwei.mul(20).toString(),
        startPrice: seaportParams.price.toString(),
        endPrice: seaportParams.price.toString(),
        startTime: seaportParams.startTime,
        endTime: seaportParams.endTime,
        currency: Common.Addresses.Weth[chainId]
      });

      const fillOrderTx = seaportExchange.fillOrderTx(
        network.initiator.address,
        seaportSellOrder,
        seaportSellOrder.buildMatching()
      );
      const gasEstimate = await network.initiator.connect(network.httpProvider).estimateGas(fillOrderTx);

      const seaportJob: JobData = {
        id: seaportSellOrder.hash(),
        orderData: {
          id: seaportSellOrder.hash(),
          order: { ...correspondingOrder.getInternalOrder(correspondingOrder.params), sig: '' },
          source: 'seaport',
          sourceOrder: seaportSellOrder.params,
          gasUsage: gasEstimate.toString(),
          status: 'active'
        }
      };

      const infinityBuyOrder = orderBuilder.build({
        isSellOrder: false,
        tokenId: tokenId.toString(),
        collection: network.test.erc721.contract.address,
        numTokens: 1,
        signer: network.test.testAccount.address,
        startPrice: parseEther('0.1').toString(),
        endPrice: parseEther('0.1').toString(),
        startTime: time,
        endTime: time + 3600,
        nonce: tokenId.toString(),
        maxGasPrice: gwei.mul(20).toString(),
        currency: Common.Addresses.Weth[chainId]
      });

      await infinityBuyOrder.sign(network.test.testAccount);

      const infinityJob: JobData = {
        id: infinityBuyOrder.hash(),
        orderData: {
          id: infinityBuyOrder.hash(),
          order: infinityBuyOrder.getSignedOrder(),
          source: 'infinity',
          sourceOrder: infinityBuyOrder.getSignedOrder(),
          gasUsage: '0',
          status: 'active'
        }
      };

      matches.push({ seaportJob, infinityJob });
    } catch (err) {
      logger.error('create-matches', `create matches - ${err}`);
    }
  }

  return matches;
}