export enum ExecutionErrorCode {
  NoBalanceData = 'NO_BALANCE_DATA',
  InsufficientErc721Balance = 'INSUFFICIENT_ERC721_BALANCE',
  InsufficientWethBalance = 'INSUFFICIENT_WETH_BALANCE',
  InsufficientWethAllowance = 'INSUFFICIENT_WETH_ALLOWANCE',
  OrderExecuted = 'ORDER_EXECUTED',
  NonceExecuted = 'NONCE_EXECUTED'
}

export class ExecutionError extends Error {
  constructor(message: string, public readonly code: ExecutionErrorCode) {
    super(message);
  }
}
