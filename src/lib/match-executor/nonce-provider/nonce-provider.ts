/* eslint-disable no-constant-condition */
import { Mutex } from 'async-mutex';
import { BigNumber, BigNumberish, ethers } from 'ethers';

import { FlowExchangeABI } from '@infinityxyz/lib/abi';
import { ChainId } from '@infinityxyz/lib/types/core';
import { ONE_MIN } from '@infinityxyz/lib/utils';

import { logger } from '@/common/logger';

import { NonceProviderDoc } from './types';

export class NonceProvider {
  protected _ref: FirebaseFirestore.DocumentReference<NonceProviderDoc>;

  protected _nonce: Promise<BigNumber> | BigNumber;
  protected _getNonceMutex: Mutex;
  protected _saveNonceMutex: Mutex;

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

    this._nonce = this._loadNonce();
    this._getNonceMutex = new Mutex();
    this._saveNonceMutex = new Mutex();
  }

  protected async _loadNonce() {
    let attempts = 0;
    while (attempts < 10) {
      attempts += 1;
      try {
        const exchange = new ethers.Contract(this._exchangeAddress, FlowExchangeABI, this._provider);
        const nonce = await this._ref.firestore.runTransaction<BigNumber>(async (txn) => {
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
        return nonce;
      } catch (err) {
        this.error(`Failed to load nonce. Attempt ${attempts} ${err}`);
      }
    }
    throw new Error('Failed to load nonce');
  }

  public async getNonce() {
    return await this._getNonceMutex.runExclusive(async () => {
      const currentNonce = await this._nonce;
      const newNonce = currentNonce.add(1);
      this._nonce = newNonce;
      this._saveNonce().catch((err) => {
        this.error(`Failed to save nonce ${err}`);
      });
      return newNonce;
    });
  }

  protected _nonceLastUpdatedAt = 0;
  protected async _saveNonce() {
    try {
      await this._saveNonceMutex.runExclusive(async () => {
        const now = Date.now();
        if (now - this._nonceLastUpdatedAt > ONE_MIN * 2) {
          try {
            this._nonceLastUpdatedAt = now;
            await this._ref.set({ nonce: this._nonce.toString(), updatedAt: now }, { merge: true });
          } catch (err) {
            this.error(`Failed to save nonce ${err}`);
          }
        }
      });
    } catch (err) {
      this.error(`Failed to save nonce ${err}`);
    }
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
