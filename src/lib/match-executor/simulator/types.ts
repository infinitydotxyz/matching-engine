import { BigNumberish } from 'ethers';

export interface Erc721Balance {
  contract: string;
  balances: {
    [tokenId: string]: {
      owner: string;
      balance: BigNumberish;
    };
  };
}

export interface WethBalances {
  contract: string;
  balances: {
    [account: string]: {
      balance: BigNumberish;
    };
  };
  allowances: {
    [account: string]: {
      [spender: string]: BigNumberish;
    };
  };
}

export interface EthBalances {
  balances: {
    [account: string]: {
      balance: BigNumberish;
    };
  };
}

export enum TransferKind {
  ERC721 = 'ERC721',
  WETH = 'WETH',
  ETH = 'ETH'
}

export interface Erc721Transfer {
  kind: TransferKind.ERC721;
  contract: string;
  tokenId: string;
  from: string;
  to: string;
}

export interface WethTransfer {
  kind: TransferKind.WETH;
  contract: string;
  operator: string;
  from: string;
  to: string;
  value: BigNumberish;
}

export interface EthTransfer {
  kind: TransferKind.ETH;
  from: string;
  to: string;
  value: BigNumberish;
}

export type Transfer = Erc721Transfer | WethTransfer | EthTransfer;

export interface ExecutionState {
  erc721Balances: { [contract: string]: Erc721Balance };
  wethBalances: WethBalances;
  ethBalances: EthBalances;
  executedOrders: { [orderHash: string]: boolean };
  executedNonces: {
    [account: string]: {
      [nonce: string]: boolean;
    };
  };
}
