import { BigNumberish, ethers } from 'ethers';

import { ChainId } from '@infinityxyz/lib/types/core';

export interface Eip1559Txn {
  from: string;
  to: string;
  type: 2;
  maxFeePerGas: BigNumberish;
  maxPriorityFeePerGas: BigNumberish;
  gasLimit: BigNumberish;
  data: string;
  chainId: number;
}

export type BroadcastOptions = {
  targetBlock: {
    blockNumber: number;
    timestamp: number;
  };
  currentBlock: {
    timestamp: number;
    blockNumber: number;
  };
};

export abstract class Broadcaster<T> {
  get chainId() {
    return parseInt(this._chainId, 10);
  }

  constructor(protected _chainId: ChainId, protected underlyingChainId: number, protected _options: T) {}

  abstract broadcast(
    txn: Omit<Eip1559Txn, 'type' | 'chainId'>,
    options: BroadcastOptions
  ): Promise<{ receipt: ethers.providers.TransactionReceipt }>;

  protected _getFullTxn(txn: Omit<Eip1559Txn, 'type' | 'chainId'>): Eip1559Txn {
    return {
      ...txn,
      chainId: this.underlyingChainId,
      type: 2
    };
  }
}
