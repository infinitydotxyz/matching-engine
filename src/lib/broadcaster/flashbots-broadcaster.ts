import { ethers } from 'ethers';

import {
  FlashbotsBundleProvider,
  FlashbotsBundleResolution,
  FlashbotsBundleTransaction
} from '@flashbots/ethers-provider-bundle';
import { getCallTrace } from '@georgeroman/evm-tx-simulator';

import { logger } from '@/common/logger';

import { BroadcastOptions, Broadcaster, Eip1559Txn } from './broadcaster.abstract';

export type Options = {
  authSigner: ethers.Wallet;
  flashbotsProvider: FlashbotsBundleProvider;
  allowReverts: boolean;
};

export class FlashbotsBroadcaster extends Broadcaster<Options> {
  protected get _flashbotsProvider() {
    return this._options.flashbotsProvider;
  }

  protected get _authSigner() {
    return this._options.authSigner;
  }

  async broadcast(txn: Omit<Eip1559Txn, 'type' | 'chainId'>, options: BroadcastOptions) {
    const fullTxn = await this._getFullTxn(txn);

    const fbTxn = {
      to: fullTxn.to,
      maxFeePerGas: options.targetBlock.maxFeePerGas,
      maxPriorityFeePerGas: options.targetBlock.maxPriorityFeePerGas,
      type: 2,
      data: fullTxn.data,
      value: fullTxn.value,
      chainId: fullTxn.chainId,
      nonce: fullTxn.nonce
    };

    const bundleTxn: FlashbotsBundleTransaction = {
      transaction: fbTxn,
      signer: options.signer
    };

    let signedBundle;
    try {
      signedBundle = await this._flashbotsProvider.signBundle([bundleTxn]);
    } catch (err) {
      logger.error('flashbots-broadcaster', `Failed to sign bundle ${JSON.stringify(err, null, 2)}`);
      throw err;
    }

    try {
      const simulationResult = await this._flashbotsProvider.simulate(signedBundle, options.targetBlock.number);

      if ('error' in simulationResult) {
        // debug call
        const result = await getCallTrace(
          {
            ...fbTxn,
            from: await options.signer.getAddress()
          },
          this._provider
        );

        console.error('Flashbots simulation failed');
        console.log(JSON.stringify(result, null, 2));

        throw new Error(simulationResult.error.message);
      }
      const totalGasUsed = simulationResult.totalGasUsed;
      const simulatedMaxFeePerGas = simulationResult.coinbaseDiff.div(totalGasUsed);

      for (const item of simulationResult.results) {
        if ('revert' in item) {
          console.log(JSON.stringify(simulationResult.results, null, 2));
          throw new Error(`Transaction ${item.txHash} Reverted with: ${item.revert}`);
        }
      }

      logger.log(
        'flashbots-broadcaster',
        `Simulated txn maxFeePerGas: ${simulatedMaxFeePerGas.toString()} gasUsed: ${totalGasUsed.toString()}`
      );
    } catch (err) {
      logger.error('flashbots-broadcaster', 'Error while simulating');
      console.log(JSON.stringify(err, null, 2));
    }

    logger.log('flashbots-broadcaster', `Broadcasting txn ${fbTxn.nonce} to flashbots`);
    const bundleResponse = await this._flashbotsProvider.sendRawBundle(signedBundle, options.targetBlock.number, {
      revertingTxHashes: this._options.allowReverts ? signedBundle : []
    });

    if ('error' in bundleResponse) {
      logger.error('flashbots-broadcaster', `Failed to send txn ${bundleResponse.error.message}`);
      throw new Error(bundleResponse.error.message);
    }

    const result = await bundleResponse.wait();

    switch (result) {
      case FlashbotsBundleResolution.BundleIncluded: {
        const receipts = await bundleResponse.receipts();
        const receipt = receipts[0];
        if (!receipt) {
          throw new Error('No receipt found');
        }
        return { receipt };
      }
      case FlashbotsBundleResolution.AccountNonceTooHigh: {
        throw new Error('Account nonce too high');
      }
      case FlashbotsBundleResolution.BlockPassedWithoutInclusion: {
        const stats = await this._flashbotsProvider.getBundleStatsV2(
          bundleResponse.bundleHash,
          options.targetBlock.number
        );
        console.log(JSON.stringify(stats, null, 2));
        throw new Error('Block passed without inclusion');
      }
    }
  }
}
