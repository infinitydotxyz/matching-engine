import { BigNumber, BigNumberish, ethers } from 'ethers';
import Redlock, { ExecutionError, RedlockAbortSignal } from 'redlock';

import { InfinityExchangeABI } from '@infinityxyz/lib/abi';
import { ChainId } from '@infinityxyz/lib/types/core';

import { logger } from '@/common/logger';

import { NonceProviderDoc } from './types';

export class NonceProvider {
  protected _nonceLoaded!: Promise<void>;
  protected _nonce!: BigNumber;

  protected _ref: FirebaseFirestore.DocumentReference<NonceProviderDoc>;

  protected _signal?: RedlockAbortSignal;

  protected _pendingSave?: NodeJS.Timeout;

  protected _saveDelay: number;

  protected _checkSignal() {
    if (!this._signal || this._signal.aborted) {
      throw new Error('Nonce provider lock expired');
    }
  }

  constructor(
    protected _chainId: ChainId,
    protected _accountAddress: string,
    protected _exchangeAddress: string,
    protected _redlock: Redlock,
    protected _provider: ethers.providers.JsonRpcProvider,
    _firestore: FirebaseFirestore.Firestore,
    options: { saveDelay: number } = { saveDelay: 100 }
  ) {
    this._ref = _firestore
      .collection('matchExecutors')
      .doc(this._accountAddress)
      .collection('nonces')
      .doc(this._exchangeAddress) as FirebaseFirestore.DocumentReference<NonceProviderDoc>;
    this._saveDelay = options.saveDelay;
  }

  public async run() {
    const nonceProviderLockKey = `nonce-provider:account:${this._accountAddress}:exchange:${this._exchangeAddress}:lock`;

    const lockDuration = 15_000;

    await this._redlock
      .using([nonceProviderLockKey], lockDuration, async (signal) => {
        logger.info(
          'nonce-provider',
          `Acquired nonce lock for account: ${this._accountAddress} exchange: ${this._exchangeAddress}`
        );
        this._nonceLoaded = this._loadNonce();
        this._signal = signal;
        await this._nonceLoaded;
        await new Promise(() => {
          // Never resolve
        });
      })
      .catch((err) => {
        if (err instanceof ExecutionError) {
          logger.warn(
            'nonce-provider',
            `Failed to acquire lock, another instance is running for account: ${this._accountAddress} exchange: ${this._exchangeAddress}`
          );
        } else {
          throw err;
        }
      });
  }

  public async getNonce() {
    this._checkSignal();
    if (!this._nonceLoaded) {
      throw new Error('Nonce provider not running');
    }
    await this._nonceLoaded;
    const nonce = this._incrementNonce();

    return nonce;
  }

  protected _incrementNonce() {
    if (!this._nonce) {
      throw new Error('Nonce provider not running');
    }
    this._nonce = this._nonce.add(1);
    this._saveNonce();
    return this._nonce;
  }

  protected _saveNonce() {
    let nonce: BigNumber | undefined;

    if (!this._pendingSave) {
      this._pendingSave = setTimeout(async () => {
        this._pendingSave = undefined;
        try {
          nonce = this._nonce;
          this._checkSignal();
          if (!nonce) {
            throw new Error('Nonce not loaded');
          }

          await this._ref.set(
            {
              nonce: nonce.toString(),
              updatedAt: Date.now()
            },
            { merge: true }
          );
        } catch (err) {
          logger.error('nonce-provider', `Failed to save nonce: ${nonce?.toString?.()} Error: ${err}`);
        }
      }, this._saveDelay);
    }
  }

  protected async _loadNonce() {
    const snap = await this._ref.get();

    const exchange = new ethers.Contract(this._exchangeAddress, InfinityExchangeABI, this._provider);
    const minNonce = BigNumber.from((await exchange.userMinOrderNonce(this._accountAddress)) as BigNumberish);

    let data = snap.data();

    if (!snap.exists || !data) {
      const initial: NonceProviderDoc = {
        chainId: this._chainId,
        matchExecutorAddress: this._accountAddress,
        exchangeAddress: this._exchangeAddress,
        nonce: minNonce.toString(),
        updatedAt: Date.now(),
        createdAt: Date.now()
      };
      await this._ref.set(initial);
      data = initial;
    }

    const nonce = minNonce.gt(data.nonce) ? minNonce : BigNumber.from(data.nonce);
    this._nonce = nonce;
  }
}
