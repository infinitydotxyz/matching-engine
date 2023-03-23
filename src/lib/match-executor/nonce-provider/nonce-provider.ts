/* eslint-disable no-constant-condition */
import { BigNumber, BigNumberish, ethers } from 'ethers';

import { FlowExchangeABI } from '@infinityxyz/lib/abi';
import { ChainId } from '@infinityxyz/lib/types/core';

import { logger } from '@/common/logger';

import { NonceProviderDoc } from './types';

export class NonceProvider {
  protected _ref: FirebaseFirestore.DocumentReference<NonceProviderDoc>;

  constructor(
    protected _chainId: ChainId,
    protected _accountAddress: string,
    protected _exchangeAddress: string,
    protected _provider: ethers.providers.StaticJsonRpcProvider,
    _firestore: FirebaseFirestore.Firestore
  ) {
    this._ref = _firestore
      .collection('matchExecutors')
      .doc(this._accountAddress)
      .collection('nonces')
      .doc(this._exchangeAddress) as FirebaseFirestore.DocumentReference<NonceProviderDoc>;
  }

  public async getNonce() {
    const nonce = this._incrementNonce();

    return nonce;
  }

  protected async _incrementNonce() {
    const exchange = new ethers.Contract(this._exchangeAddress, FlowExchangeABI, this._provider);
    return await this._ref.firestore.runTransaction<BigNumber>(async (txn) => {
      const [snap, minNonceString] = await Promise.all([
        txn.get(this._ref),
        exchange.userMinOrderNonce(this._accountAddress) as Promise<BigNumberish>
      ]);

      const minNonce = BigNumber.from(minNonceString);

      let data = snap.data();

      if (!snap.exists || !data) {
        const initial: NonceProviderDoc = {
          chainId: this._chainId,
          matchExecutorAddress: this._accountAddress,
          exchangeAddress: this._exchangeAddress,
          nonce: minNonce.add(1).toString(),
          updatedAt: Date.now(),
          createdAt: Date.now()
        };
        txn.set(this._ref, initial);
        data = initial;

        return BigNumber.from(initial.nonce);
      } else {
        const nonce = (minNonce.gt(data.nonce) ? minNonce : BigNumber.from(data.nonce)).add(1);
        txn.set(
          this._ref,
          {
            nonce: nonce.toString(),
            updatedAt: Date.now()
          },
          { merge: true }
        );
        return nonce;
      }
    });
  }

  log(message: string) {
    logger.log('nonce-provider', message);
  }
  error(message: string) {
    logger.error('nonce-provider', message);
  }
  warn(message: string) {
    logger.warn('nonce-provider', message);
  }
}
