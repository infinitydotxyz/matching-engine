import { BigNumber, ethers } from 'ethers';

import { ChainId } from '@infinityxyz/lib/types/core';
import { Infinity, Common, Seaport } from '@reservoir0x/sdk';

import SeaportConduitControllerAbi from '@/common/abi/seaport-conduit-controller.json';
import { OrderData } from '@/lib/orderbook/v1/types';

import { NonNativeMatchExecutionInfo } from '../../match/types';
import { Erc721Transfer, EthTransfer, TransferKind, WethTransfer } from '../../simulator/types';
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
    this._order = new Seaport.Order(this.chainId, this._params);
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
    return this._params.startTime;
  }

  public get endTime() {
    return this._params.endTime;
  }

  public get startPrice() {
    const items = this.isSellOrder ? this._params.consideration : this._params.offer;

    let price = BigNumber.from(0);

    for (const item of items) {
      price = price.add(BigNumber.from(item.startAmount));
    }

    return price.toString();
  }

  public get endPrice() {
    const items = this.isSellOrder ? this._params.consideration : this._params.offer;

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
    if (!zones.includes(this._params.zone)) {
      throw new OrderError('unknown zone', ErrorCode.SeaportZone, this._params.zone, this.source, 'unsupported');
    }

    if (this._params.conduitKey !== Seaport.Addresses.OpenseaConduitKey[this.chainId]) {
      throw new OrderError(
        `invalid conduitKey`,
        ErrorCode.SeaportConduitKey,
        `${this._params.conduitKey}`,
        'seaport',
        'unsupported'
      );
    }

    this._checkOrderKindValid();
  }

  public get isERC721(): boolean {
    const items = this.isSellOrder ? this._params.offer : this._params.consideration;
    const erc721ItemTypes = new Set([Seaport.Types.ItemType.ERC721]); // don't include ERC721 with criteria
    return items.every((offerItem) => {
      return erc721ItemTypes.has(offerItem.itemType);
    });
  }

  public get currency(): string {
    const items = this.isSellOrder ? this._params.consideration : this._params.offer;

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
    const items = this.isSellOrder ? this._params.offer : this._params.consideration;

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
    const conduitController = new ethers.Contract(
      Seaport.Addresses.ConduitController[this.chainId],
      SeaportConduitControllerAbi,
      this._provider
    );

    const makerConduit = BigNumber.from(this._params.conduitKey).eq(0)
      ? Seaport.Addresses.Exchange[this.chainId]
      : await conduitController
          .getConduit(this._params.conduitKey)
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
        to: this._params.offerer,
        value: value.toString() // TODO consider fees
      };
    } else {
      currencyTransfer = {
        kind: TransferKind.ETH,
        from: taker,
        to: this._params.offerer,
        value: value.toString()
      };
    }

    const erc721Transfers: Erc721Transfer[] = this.nfts.flatMap(({ collection, tokens }) => {
      return tokens.map((token) => ({
        kind: TransferKind.ERC721,
        contract: collection,
        operator: makerConduit.toLowerCase(),
        from: this._params.offerer,
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