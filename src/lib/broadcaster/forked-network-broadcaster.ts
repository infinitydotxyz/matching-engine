import { ethers } from 'ethers';

import { logger } from '@/common/logger';

import { BroadcastOptions, Broadcaster, Eip1559Txn } from './broadcaster.abstract';

export type Options = {
  provider: ethers.providers.JsonRpcProvider;
};

export class ForkedNetworkBroadcaster extends Broadcaster<Options> {
  async broadcast(txn: Omit<Eip1559Txn, 'type' | 'chainId'>, options: BroadcastOptions) {
    const fullTxn = await this._getFullTxn(txn);

    try {
      const result = await options.signer.connect(this._options.provider).sendTransaction(fullTxn);
      const receipt = await this._options.provider.waitForTransaction(result.hash, 1);

      return { receipt };
    } catch (err) {
      logger.error('forked-network-broadcaster', `Failed to send/wait for txn ${err}`);
      throw err;
    }
  }
}
