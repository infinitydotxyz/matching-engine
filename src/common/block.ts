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
