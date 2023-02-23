export interface Block {
  timestamp: number;
  number: number;
  baseFeePerGas: string;
}

export interface BlockWithMaxFeePerGas extends Block {
  maxFeePerGas: string;
}

export interface BlockWithGas extends BlockWithMaxFeePerGas {
  maxPriorityFeePerGas: string;
}

interface BaseExecutionBlock extends BlockWithGas {
  numExecutableMatches: number;
  numInexecutableMatches: number;
}

export interface PendingExecutionBlock extends BaseExecutionBlock {
  status: 'pending';
  timing: {
    initiatedAt: number;
  };
  balanceChanges: {
    totalBalanceDiff: string;
    ethBalanceDiff: string;
    wethBalanceDiff: string;
  };
}

export interface SkippedExecutionBlock extends BaseExecutionBlock {
  status: 'skipped';
  reason: string;
  timing: {
    initiatedAt: number;
  };
}

export interface NotIncludedBlock extends BaseExecutionBlock {
  status: 'not-included';
  effectiveGasPrice: string;
  cumulativeGasUsed: string;
  gasUsed: string;
  txHash: string;
  timing: {
    initiatedAt: number;
    receiptReceivedAt: number;
  };
  balanceChanges: {
    totalBalanceDiff: string;
    ethBalanceDiff: string;
    wethBalanceDiff: string;
  };
}

export interface ExecutedBlock extends BaseExecutionBlock {
  status: 'executed';
  effectiveGasPrice: string;
  cumulativeGasUsed: string;
  gasUsed: string;
  txHash: string;
  timing: {
    initiatedAt: number;
    blockTimestamp: number;
    receiptReceivedAt: number;
  };
  balanceChanges: {
    totalBalanceDiff: string;
    ethBalanceDiff: string;
    wethBalanceDiff: string;
  };
}

export type ExecutionBlock = PendingExecutionBlock | SkippedExecutionBlock | NotIncludedBlock | ExecutedBlock;
