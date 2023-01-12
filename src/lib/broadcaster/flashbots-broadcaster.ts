import { ethers, providers } from 'ethers';

import { FlashbotsBundleProvider, FlashbotsBundleTransaction } from '@flashbots/ethers-provider-bundle';

import { logger } from '@/common/logger';

import { BroadcastOptions, Broadcaster, Eip1559Txn } from './broadcaster.abstract';

export type Options = {
  authSigner: ethers.Wallet;
  provider: providers.JsonRpcProvider;
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

  protected get _provider() {
    return this._options.provider;
  }

  async broadcast(txn: Omit<Eip1559Txn, 'type' | 'chainId'>, options: BroadcastOptions) {
    const fullTxn = this._getFullTxn(txn);

    const bundleTxn: FlashbotsBundleTransaction = {
      transaction: fullTxn,
      signer: this._authSigner
    };
    const signedBundle = await this._flashbotsProvider.signBundle([bundleTxn]);
    const simulationResult = await this._flashbotsProvider.simulate(signedBundle, 'latest');

    if ('error' in simulationResult) {
      throw new Error(simulationResult.error.message);
    }
    const totalGasUsed = simulationResult.totalGasUsed;
    const simulatedMaxFeePerGas = simulationResult.coinbaseDiff.div(totalGasUsed);

    logger.log(
      'flashbots-broadcaster',
      `Simulated txn maxFeePerGas: ${simulatedMaxFeePerGas.toString()} gasUsed: ${totalGasUsed.toString()}`
    );

    const maxTimestamp =
      options.targetBlock.timestamp + (options.targetBlock.timestamp - options.currentBlock.timestamp);

    const bundleResponse = await this._flashbotsProvider.sendRawBundle(signedBundle, options.targetBlock.blockNumber, {
      minTimestamp: options.currentBlock.timestamp,
      maxTimestamp,
      revertingTxHashes: this._options.allowReverts ? signedBundle : []
    });

    if ('error' in bundleResponse) {
      logger.error('flashbots-broadcaster', `Failed to send txn ${bundleResponse.error.message}`);
      throw new Error(bundleResponse.error.message);
    }

    const receipts = await bundleResponse.receipts();
    const receipt = receipts[0];

    if (!receipt) {
      throw new Error('No receipt found');
    }

    return { receipt };
  }
}
