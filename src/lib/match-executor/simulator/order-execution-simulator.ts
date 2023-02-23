import { BigNumber, BigNumberish } from 'ethers';

import { ValidityResult } from '@/lib/utils/validity-result';

import { MatchExecutionInfo, NativeMatchExecutionInfo } from '../match/types';
import { ExecutionError, ExecutionErrorCode } from './error';
import { Erc721Transfer, EthTransfer, ExecutionState, Transfer, TransferKind, WethTransfer } from './types';

export class OrderExecutionSimulator {
  protected _currentState: ExecutionState;

  constructor(protected _initialState: ExecutionState) {
    this._currentState = this._clone(_initialState);
  }

  isErc721Owner(contract: string, tokenId: string, owner: string) {
    const tokenBalance = this._currentState.erc721Balances[contract]?.balances?.[tokenId];
    if (tokenBalance?.owner === owner) {
      return true;
    }
    return false;
  }

  getWethBalance(account: string) {
    const accountBalance = this._currentState.wethBalances?.balances?.[account]?.balance ?? '0';
    return BigNumber.from(accountBalance);
  }

  getEthBalance(account: string) {
    const accountBalance = this._currentState.ethBalances?.balances?.[account]?.balance ?? '0';
    return BigNumber.from(accountBalance);
  }

  getWethAllowance(account: string, spender: string) {
    const accountApproval = this._currentState.wethBalances?.allowances?.[account]?.[spender] ?? '0';
    return BigNumber.from(accountApproval);
  }

  reset() {
    this._currentState = this._clone(this._initialState);
  }

  simulateMatch(execInfo: MatchExecutionInfo): ValidityResult {
    const preSimulationState = this._clone(this._currentState);

    try {
      if (!execInfo.isNative) {
        for (const transfer of execInfo.nonNativeExecutionTransfers) {
          this._handleTransfer(transfer);
        }
      } else {
        for (const transfer of execInfo.nativeExecutionTransfers) {
          this._handleTransfer(transfer);
        }
        this._handleNonces(execInfo.orderNonces);
      }
      this._handleIds(execInfo.orderIds);

      return { isValid: true };
    } catch (err) {
      this._revert(preSimulationState);
      if (err instanceof ExecutionError) {
        return { isValid: false, reason: err.message, isTransient: err.isTransient };
      }
      return {
        isValid: false,
        reason:
          typeof err === 'object' && err && 'message' in err && typeof err.message === 'string'
            ? err.message
            : `${JSON.stringify(err)}`,
        isTransient: true
      };
    }
  }

  protected _clone(state: ExecutionState): ExecutionState {
    return JSON.parse(JSON.stringify(state));
  }

  protected _revert(state: ExecutionState) {
    this._currentState = this._clone(state);
  }

  protected _handleIds(orderIds: MatchExecutionInfo['orderIds']) {
    for (const orderId of orderIds) {
      if (this._currentState.executedOrders[orderId]) {
        throw new ExecutionError(`Order ${orderId} has already been executed`, ExecutionErrorCode.OrderExecuted, true);
      }

      this._currentState.executedOrders[orderId] = true;
    }
  }

  protected _handleNonces(nonces: NativeMatchExecutionInfo['orderNonces']) {
    for (const [account, accountNonces] of Object.entries(nonces)) {
      for (const _nonce of accountNonces) {
        const nonce = _nonce.toString();
        if (this._currentState.executedNonces[account]?.[nonce]) {
          throw new ExecutionError(
            `Nonce ${nonce} for account ${account} has already been executed`,
            ExecutionErrorCode.NonceExecuted,
            true
          );
        }

        this._currentState.executedNonces[account] = this._currentState.executedNonces[account] ?? {};
        this._currentState.executedNonces[account][nonce] = true;
      }
    }
  }

  protected _handleTransfer(transfer: Transfer) {
    switch (transfer.kind) {
      case TransferKind.ERC721:
        this._handleErc721Transfer(transfer);
        break;
      case TransferKind.WETH:
      case TransferKind.ETH:
        this._handleCurrencyTransfer(transfer);
        break;
    }
  }

  protected _handleErc721Transfer({ contract, tokenId, from, to }: Erc721Transfer) {
    const token = this._currentState.erc721Balances[contract]?.balances?.[tokenId];

    if (!token) {
      throw new ExecutionError(
        `No ERC721 balance data for contract ${contract} token ${tokenId}`,
        ExecutionErrorCode.NoBalanceData,
        true
      );
    } else if (token.owner !== from) {
      throw new ExecutionError(
        `ERC721 token ${tokenId} is not owned by ${from}`,
        ExecutionErrorCode.InsufficientErc721Balance,
        true
      );
    }

    token.owner = to;
  }

  protected _handleCurrencyTransfer(transfer: WethTransfer | EthTransfer) {
    const { from, to, value } = transfer;
    const isWeth = transfer.kind === TransferKind.WETH;

    const getBalance = (account: string) => {
      if (isWeth) {
        return this._currentState.wethBalances?.balances?.[account]?.balance;
      }
      return this._currentState.ethBalances?.balances?.[account]?.balance;
    };

    const setBalance = (account: string, balance: BigNumberish) => {
      if (isWeth) {
        if (!(account in this._currentState.wethBalances.balances)) {
          this._currentState.wethBalances.balances[account] = {
            balance: '0'
          };
        }
        this._currentState.wethBalances.balances[account].balance = balance.toString();
      } else {
        if (!(account in this._currentState.ethBalances.balances)) {
          this._currentState.ethBalances.balances[account] = {
            balance: '0'
          };
        }

        this._currentState.ethBalances.balances[account].balance = balance.toString();
      }
    };

    const balance = getBalance(from);
    if (balance == null) {
      throw new ExecutionError(`No WETH balance data for account ${from}`, ExecutionErrorCode.NoBalanceData, true);
    }

    const fromAccountBalance = BigNumber.from(balance);
    if (fromAccountBalance.lt(value)) {
      throw new ExecutionError(
        `WETH balance of ${from} is insufficient. Required ${value.toString()}. Balance: ${fromAccountBalance.toString()}`,
        ExecutionErrorCode.InsufficientWethBalance,
        true
      );
    }

    if (isWeth) {
      const { operator } = transfer;
      const allowance = this._currentState.wethBalances.allowances?.[from]?.[operator];
      if (allowance == null) {
        throw new ExecutionError(
          `No WETH allowance data for account ${from} and operator ${operator}`,
          ExecutionErrorCode.NoBalanceData,
          true
        );
      }
      const accountAllowance = BigNumber.from(allowance ?? '0');
      if (accountAllowance.lt(value)) {
        throw new ExecutionError(
          `WETH allowance of ${from} for ${operator} is insufficient. Required ${value.toString()}. Allowance: ${allowance.toString()}`,
          ExecutionErrorCode.InsufficientWethAllowance,
          true
        );
      }

      const updatedAllowance = accountAllowance.sub(value);
      this._currentState.wethBalances.allowances[from][operator] = updatedAllowance.toString();
    }
    const toAccountBalance = BigNumber.from(getBalance(to) ?? '0');

    const updatedFromBalance = fromAccountBalance.sub(value);
    setBalance(from, updatedFromBalance);
    const updatedToBalance = toAccountBalance.add(value);
    setBalance(to, updatedToBalance);
  }
}
