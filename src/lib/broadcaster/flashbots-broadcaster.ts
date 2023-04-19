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

  isForked = false;

  protected get _authSigner() {
    return this._options.authSigner;
  }

  async broadcast(txn: Omit<Eip1559Txn, 'type' | 'chainId'>, options: BroadcastOptions) {
    const fullTxn = await this._getFullTxn(txn);

    const fbTxn = {
      to: fullTxn.to,
      type: 2,
      maxFeePerGas: options.targetBlock.maxFeePerGas,
      maxPriorityFeePerGas: options.targetBlock.maxPriorityFeePerGas,
      gasLimit: txn.gasLimit,
      data: fullTxn.data,
      chainId: fullTxn.chainId,
      value: fullTxn.value,
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
      logger.error('flashbots-broadcaster', `Failed to sign bundle ${err}`);
      throw err;
    }

    try {
      const simulationResult = await this._flashbotsProvider.simulate(signedBundle, options.targetBlock.number);

      if ('error' in simulationResult) {
        // debug call
        try {
          logger.error(
            'flashbots-broadcaster',
            `Flashbots simulation failed: ${simulationResult.error.message} Attempting to get call trace`
          );
          console.log(JSON.stringify(fbTxn, null, 2));
          const result = await getCallTrace(
            {
              ...fbTxn,
              from: await options.signer.getAddress()
            },
            this._provider
          );
          console.log(JSON.stringify(result, null, 2));
        } catch (err) {
          console.error('Failed to get call trace');
        }
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
        `Simulated txn maxPriorityFeePerGas: ${simulatedMaxFeePerGas.toString()} gasUsed: ${totalGasUsed.toString()}`
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

    try {
      const sim = await bundleResponse.simulate();
      if ('error' in sim) {
        logger.error(
          'flashbots-broadcaster',
          `Received error in simulation result ${(JSON.stringify(sim.error), null, 2)}`
        );
      } else if (sim.firstRevert) {
        logger.error('flashbots-broadcaster', `Received revert in simulation result ${sim}`);
      }
    } catch (err) {
      logger.error('flashbots-broadcaster', `Failed to get simulation result ${err}`);
    }

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
