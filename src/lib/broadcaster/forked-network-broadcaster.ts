import { ethers } from 'ethers';

import { logger } from '@/common/logger';

import { Broadcaster, Eip1559Txn } from './broadcaster.abstract';

export type Options = {
  wallet: ethers.Wallet;
  provider: ethers.providers.JsonRpcProvider;
};

export class ForkedNetworkBroadcaster extends Broadcaster<Options> {
  async broadcast(txn: Omit<Eip1559Txn, 'type' | 'chainId'>) {
    const fullTxn = this._getFullTxn(txn);

    try {
      const result = await this._options.wallet.connect(this._options.provider).sendTransaction(fullTxn);
      const receipt = await this._options.provider.waitForTransaction(result.hash, 1);

      return { receipt, txn: result };
    } catch (err) {
      logger.error('forked-network-broadcaster', `Failed to send/wait for txn ${err}`);
      throw err;
    }
  }
}
