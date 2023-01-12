import { BigNumberish, ethers } from 'ethers';

import { ChainId } from '@infinityxyz/lib/types/core';

import MatchExecutorAbi from '@/common/abi/match-executor.json';

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
    public owner: ethers.Wallet,
    public nonceProvider: NonceProvider
  ) {
    this._contract = new ethers.Contract(this.address, MatchExecutorAbi, this.owner);
  }

  getNativeTxn(
    matches: MatchOrders[],
    maxFeePerGas: BigNumberish,
    maxPriorityFeePerGas: BigNumberish,
    gasLimit: BigNumberish
  ) {
    const encoded = this._contract.interface.encodeFunctionData('executeNativeMatches', [matches]);
    const txn = {
      from: this.owner.address,
      to: this.address,
      maxFeePerGas: maxFeePerGas.toString(),
      maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
      gasLimit: gasLimit.toString(),
      data: encoded
    };

    return txn;
  }

  getBrokerTxn(batch: Batch, maxFeePerGas: BigNumberish, maxPriorityFeePerGas: BigNumberish, gasLimit: BigNumberish) {
    const encoded = this._contract.interface.encodeFunctionData('executeBrokerMatches', [[batch]]);
    const txn = {
      from: this.owner.address,
      to: this.address,
      maxFeePerGas: maxFeePerGas.toString(),
      maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
      gasLimit: gasLimit.toString(),
      data: encoded
    };
    return txn;
  }
}
