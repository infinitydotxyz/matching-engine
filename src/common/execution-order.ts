import { BlockWithGas } from './block';

interface BaseExecutionOrder {
  matchId: string;
  matchedOrderId: string;
  block: BlockWithGas;
}

export interface PendingExecutionOrder extends BaseExecutionOrder {
  status: 'pending';
  timing: {
    initiatedAt: number;
  };
}

export interface InexecutableExecutionOrder extends BaseExecutionOrder {
  status: 'inexecutable';
  reason: string;
  timing: {
    initiatedAt: number;
  };
}

export interface NotIncludedExecutionOrder extends BaseExecutionOrder {
  status: 'not-included';
  effectiveGasPrice: string;
  cumulativeGasUsed: string;
  gasUsed: string;
  timing: {
    initiatedAt: number;
    receiptReceivedAt: number;
  };
}

export interface ExecutedExecutionOrder extends BaseExecutionOrder {
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
}
