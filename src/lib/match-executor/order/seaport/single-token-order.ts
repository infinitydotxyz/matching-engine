import { BigNumber, constants, ethers } from 'ethers';

import { Seaport } from '@reservoir0x/sdk';

import SeaportConduitControllerAbi from '@/common/abi/seaport-conduit-controller.json';

import { NonNativeMatchExecutionInfo } from '../../match/types';
import { Erc721Transfer, EthTransfer, TransferKind, WethTransfer } from '../../simulator/types';
import { ErrorCode } from '../errors/error-code';
import { OrderError } from '../errors/order-error';
import { SeaportOrder } from './order.abstract';

export class SingleTokenOrder extends SeaportOrder {
  protected _checkOrderKindValid(): void {
    if (this.numItems !== 1) {
      throw new OrderError(
        "expected a single token order, but the order's numItems is not 1",
        ErrorCode.OrderTokenQuantity,
        `${this.numItems}`,
        this.source,
        'unexpected'
      );
    }
  }
}
