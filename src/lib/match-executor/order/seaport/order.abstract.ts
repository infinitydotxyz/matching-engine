import { BigNumber, ethers } from 'ethers';

import { ChainId, ChainNFTs } from '@infinityxyz/lib/types/core';
import { Infinity, Common, Seaport } from '@reservoir0x/sdk';

import SeaportConduitControllerAbi from '@/common/abi/seaport-conduit-controller.json';
import { OrderData } from '@/lib/orderbook/v1/types';

import { NonNativeMatchExecutionInfo } from '../../match/types';
import { Erc721Transfer, EthTransfer, TransferKind, WethTransfer } from '../../simulator/types';
import { Call } from '../../types';
import { ErrorCode } from '../errors/error-code';
import { OrderCurrencyError, OrderDynamicError, OrderError, OrderKindError } from '../errors/order-error';
import { NonNativeOrder } from '../non-native-order';

export abstract class SeaportOrder extends NonNativeOrder<Seaport.Types.OrderComponents> {
  readonly source = 'seaport';

  protected _order: Seaport.Order;

  get gasUsage() {
    return this._orderData.gasUsage;
  }

  constructor(_orderData: OrderData, _chainId: ChainId, provider: ethers.providers.JsonRpcProvider) {
    super(_orderData, _chainId, provider);
    this._order = new Seaport.Order(this.chainId, this._sourceParams);
  }

  getExternalFulfillment(taker: string): Promise<{ call: Call; nftsToTransfer: ChainNFTs[] }> {
    const exchange = new Seaport.Exchange(this.chainId);
    const matchParams = this._order.buildMatching();
    const txn = exchange.fillOrderTx(taker, this._order, matchParams);
    const value = BigNumber.from(txn.value ?? '0');

    const call: Call = {
      to: txn.to,
      data: txn.data,
      value: value.toString(),
      isPayable: value.gt(0)
    };

    return Promise.resolve({ call, nftsToTransfer: this._orderData.order.nfts });
  }

  /**
   * perform order kind specific checks on the order
   */
  protected abstract _checkOrderKindValid(): void;

  protected getExecutionTransfers(taker: string, exchangeAddress: string) {
    const currency = this.currency;
    const amount = this.startPrice;

    let currencyTransfer: EthTransfer | WethTransfer;
    if (currency === Common.Addresses.Eth[this.chainId]) {
      const ethTransfer: EthTransfer = {
        kind: TransferKind.ETH,
        value: amount,
        from: this.maker,
        to: taker
      };
      currencyTransfer = ethTransfer;
    } else if (currency === Common.Addresses.Weth[this.chainId]) {
      const wethTransfer: WethTransfer = {
        kind: TransferKind.WETH,
        value: amount,
        from: this.maker,
        to: taker,
        contract: currency,
        operator: exchangeAddress
      };
      currencyTransfer = wethTransfer;
    } else {
      throw new Error('Invalid currency');
    }

    const tokens = this.nfts;

    const erc721Transfers: Erc721Transfer[] = tokens.flatMap(({ collection, tokens }) => {
      return tokens.map((token) => {
        const erc721Transfer: Erc721Transfer = {
          kind: TransferKind.ERC721,
          from: this.maker,
          to: taker,
          contract: collection,
          tokenId: token.tokenId
        };
        return erc721Transfer;
      });
    });

    return [currencyTransfer, ...erc721Transfers];
  }

  public get isSellOrder() {
    return this._orderData.order.isSellOrder;
  }

  public get kind() {
    return this._order.params.kind;
  }

  public get maker() {
    return this._order.params.offerer;
  }

  public get startTime() {
    return this._sourceParams.startTime;
  }

  public get endTime() {
    return this._sourceParams.endTime;
  }

  public get startPrice() {
    const items = this.isSellOrder ? this._sourceParams.consideration : this._sourceParams.offer;

    let price = BigNumber.from(0);

    for (const item of items) {
      price = price.add(BigNumber.from(item.startAmount));
    }

    return price.toString();
  }

  public get endPrice() {
    const items = this.isSellOrder ? this._sourceParams.consideration : this._sourceParams.offer;

    let price = BigNumber.from(0);

    for (const item of items) {
      price = price.add(BigNumber.from(item.endAmount));
    }

    return price.toString();
  }

  public get isPrivate() {
    return false;
  }

  public _checkValid() {
    /**
     * order kind should be known
     */
    if (!this.kind) {
      throw new OrderKindError(`${this.kind}`, 'seaport', 'unexpected');
    }

    const zones = [ethers.constants.AddressZero, Seaport.Addresses.PausableZone[this.chainId]];
    if (!zones.includes(this._sourceParams.zone)) {
      throw new OrderError('unknown zone', ErrorCode.SeaportZone, this._sourceParams.zone, this.source, 'unsupported');
    }

    if (this._sourceParams.conduitKey !== Seaport.Addresses.OpenseaConduitKey[this.chainId]) {
      throw new OrderError(
        `invalid conduitKey`,
        ErrorCode.SeaportConduitKey,
        `${this._sourceParams.conduitKey}`,
        'seaport',
        'unsupported'
      );
    }

    this._checkOrderKindValid();
  }

  public get isERC721(): boolean {
    const items = this.isSellOrder ? this._sourceParams.offer : this._sourceParams.consideration;
    const erc721ItemTypes = new Set([Seaport.Types.ItemType.ERC721]); // don't include ERC721 with criteria
    return items.every((offerItem) => {
      return erc721ItemTypes.has(offerItem.itemType);
    });
  }

  public get currency(): string {
    const items = this.isSellOrder ? this._sourceParams.consideration : this._sourceParams.offer;

    let currency: string | undefined = undefined;
    for (const item of items) {
      if (currency && currency !== item.token) {
        throw new OrderCurrencyError(this.source, currency);
      }
      currency = item.token;
    }

    if (!currency) {
      throw new OrderCurrencyError(this.source, `${currency}`);
    }

    return currency;
  }

  public get numItems(): number {
    const items = this.nfts;

    let numItems = 0;
    for (const item of items) {
      numItems += item.tokens.length;
    }

    return numItems;
  }

  public get nfts() {
    const items = this.isSellOrder ? this._sourceParams.offer : this._sourceParams.consideration;

    const nfts: { [collection: string]: { [tokenId: string]: number } } = {};

    for (const item of items) {
      if (item.startAmount !== item.endAmount) {
        throw new OrderDynamicError(this.source);
      }
      if (item.itemType !== Seaport.Types.ItemType.ERC721) {
        throw new OrderError('non-erc721 order', ErrorCode.OrderTokenStandard, `true`, this.source);
      }

      /**
       * identifier or criteria is the token id
       * when the `itemType` is `ERC721
       */
      const tokenId = item.identifierOrCriteria;

      const quantity = parseInt(item.startAmount, 10);

      if (quantity !== 1) {
        throw new OrderError('quantity is not 1', ErrorCode.OrderTokenQuantity, `${quantity}`, this.source);
      }

      const collection = item.token;

      if (!(collection in nfts)) {
        nfts[collection] = {};
      }

      if (tokenId in nfts[collection]) {
        throw new OrderError('duplicate token id', ErrorCode.DuplicateToken, tokenId, this.source);
      } else {
        nfts[collection][tokenId] = quantity;
      }
    }

    const orderItems: Infinity.Types.OrderNFTs[] = Object.entries(nfts).map(([key, value]) => {
      const collection = key;
      const nft = {
        collection,
        tokens: [] as Infinity.Types.OrderNFTs['tokens']
      };

      for (const [tokenId, quantity] of Object.entries(value)) {
        nft.tokens.push({
          tokenId,
          numTokens: quantity
        });
      }

      return nft;
    });

    return orderItems;
  }

  async getExecutionInfo(taker: string): Promise<Omit<NonNativeMatchExecutionInfo, 'nativeExecutionTransfers'>> {
    const conduit = Seaport.Addresses.ConduitController[this.chainId];
    const conduitController = new ethers.Contract(conduit, SeaportConduitControllerAbi, this._provider);

    const makerConduit = BigNumber.from(this._sourceParams.conduitKey).eq(0)
      ? Seaport.Addresses.Exchange[this.chainId]
      : await conduitController
          .getConduit(this._sourceParams.conduitKey)
          .then((result: { exists: boolean; conduit: string }) => {
            if (!result.exists) {
              throw new Error('invalid-conduit');
            } else {
              return result.conduit.toLowerCase();
            }
          });

    const isWeth = this.currency === this.weth;

    let currencyTransfer: WethTransfer | EthTransfer;

    const value = this.startPrice;
    if (isWeth) {
      currencyTransfer = {
        kind: TransferKind.WETH,
        contract: this.currency,
        operator: makerConduit,
        from: taker,
        to: this._sourceParams.offerer,
        value: value.toString() // TODO consider fees
      };
    } else {
      currencyTransfer = {
        kind: TransferKind.ETH,
        from: taker,
        to: this._sourceParams.offerer,
        value: value.toString()
      };
    }

    const erc721Transfers: Erc721Transfer[] = this.nfts.flatMap(({ collection, tokens }) => {
      return tokens.map((token) => ({
        kind: TransferKind.ERC721,
        contract: collection,
        operator: makerConduit.toLowerCase(),
        from: this._sourceParams.offerer,
        to: taker,
        tokenId: token.tokenId
      }));
    });

    return {
      isNative: false,
      sourceTxnGasUsage: this._orderData.gasUsage,
      nonNativeExecutionTransfers: [currencyTransfer, ...erc721Transfers],
      orderIds: [this._orderData.id]
    };
  }
}
