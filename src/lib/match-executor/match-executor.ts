import { BigNumberish, ethers } from 'ethers';

import { ChainId } from '@infinityxyz/lib/types/core';

import MatchExecutorAbi from '@/common/abi/match-executor.json';
import { BlockWithGas } from '@/common/block';

import { NonceProvider } from './nonce-provider/nonce-provider';
import { Batch, MatchOrders } from './types';

export class MatchExecutor {
  protected get chain() {
    return parseInt(this.chainId, 10);
  }

  protected _contract: ethers.Contract;

  constructor(
    public chainId: ChainId,
    public address: string,
    public initiator: ethers.Wallet,
    public nonceProvider: NonceProvider
  ) {
    this._contract = new ethers.Contract(this.address, MatchExecutorAbi, this.initiator);
  }

  getNativeTxn(matches: MatchOrders[], targetBlock: BlockWithGas, gasLimit: BigNumberish) {
    const encoded = this._contract.interface.encodeFunctionData('executeNativeMatches', [matches]);
    const txn = {
      from: this.initiator.address.toLowerCase(),
      to: this.address,
      maxFeePerGas: targetBlock.maxFeePerGas,
      maxPriorityFeePerGas: targetBlock.maxPriorityFeePerGas,
      gasLimit: gasLimit.toString(),
      data: encoded
    };

    return txn;
  }

  getBrokerTxn(batch: Batch, targetBlock: BlockWithGas, gasLimit: BigNumberish) {
    const encoded = this._contract.interface.encodeFunctionData('executeBrokerMatches', [[batch]]);
    const txn = {
      from: this.initiator.address.toLowerCase(),
      to: this.address,
      maxFeePerGas: targetBlock.maxFeePerGas,
      maxPriorityFeePerGas: targetBlock.maxPriorityFeePerGas,
      gasLimit: gasLimit.toString(),
      data: encoded
    };
    return txn;
  }
}
