import { BigNumberish, ethers } from 'ethers';

import { ChainId } from '@infinityxyz/lib/types/core';

import { Block, BlockWithGas } from '@/common/block';

export interface Eip1559Txn {
  from: string;
  to: string;
  type: 2;
  maxFeePerGas: BigNumberish;
  maxPriorityFeePerGas: BigNumberish;
  gasLimit: BigNumberish;
  data: string;
  chainId: number;
  nonce: BigNumberish;
  value: string;
}

export type BroadcastOptions = {
  targetBlock: BlockWithGas;
  currentBlock: Block;
  signer: ethers.Signer;
};

export abstract class Broadcaster<T> {
  get chainId() {
    return parseInt(this._chainId, 10);
  }

  constructor(
    protected _chainId: ChainId,
    protected underlyingChainId: number,
    protected _provider: ethers.providers.StaticJsonRpcProvider,
    protected _options: T
  ) {}

  abstract broadcast(
    txn: Omit<Eip1559Txn, 'type' | 'chainId' | 'nonce' | 'value'>,
    options: BroadcastOptions
  ): Promise<{ receipt: ethers.providers.TransactionReceipt }>;

  protected async _getNonce(account: string) {
    const nonce = await this._provider.getTransactionCount(account);
    return nonce;
  }

  protected async _getFullTxn(txn: Omit<Eip1559Txn, 'type' | 'chainId' | 'value' | 'nonce'>): Promise<Eip1559Txn> {
    const nonce = await this._getNonce(txn.from);
    return {
      ...txn,
      value: '0',
      nonce,
      chainId: this.underlyingChainId,
      type: 2
    };
  }
}
