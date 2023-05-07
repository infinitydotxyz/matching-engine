import { BigNumber, ethers } from 'ethers';
import phin from 'phin';

import { ChainId, ChainNFTs } from '@infinityxyz/lib/types/core';
import { Flow, SeaportBase, SeaportV14 } from '@reservoir0x/sdk';

import SeaportConduitControllerAbi from '@/common/abi/seaport-conduit-controller.json';
import { logger } from '@/common/logger';
import { config } from '@/config';
import { OrderData } from '@/lib/orderbook/v1/types';
import { ValidityResult, ValidityResultWithData } from '@/lib/utils/validity-result';

import { NonNativeMatchExecutionInfo } from '../../match/types';
import { Erc721Transfer, EthTransfer, TransferKind, WethTransfer } from '../../simulator/types';
import { Call } from '../../types';
import { ErrorCode } from '../errors/error-code';
import { OrderCurrencyError, OrderDynamicError, OrderError, OrderKindError } from '../errors/order-error';
import { NonNativeOrder } from '../non-native-order';

export abstract class SeaportV14Order extends NonNativeOrder<SeaportBase.Types.OrderComponents> {
  readonly source = 'seaport-v1.4';

  protected _order: SeaportV14.Order;

  get gasUsage() {
    return this._orderData.gasUsage;
  }

  constructor(_orderData: OrderData, _chainId: ChainId, provider: ethers.providers.StaticJsonRpcProvider) {
    super(_orderData, _chainId, provider);
    this._order = new SeaportV14.Order(this.chainId, this._sourceParams);
  }

  async prepareOrder(params: { taker: string }): Promise<ValidityResult> {
    if (!this._order.params.signature) {
      const signatureResult = await this.getSignature(params.taker);
      if (!signatureResult.isValid) {
        return {
          isValid: false,
          isTransient: signatureResult.isTransient,
          reason: signatureResult.reason
        };
      } else {
        this._order.params.signature = signatureResult.data;
      }
    }
    return {
      isValid: true
    };
  }

  async getExternalFulfillment(
    taker: string
  ): Promise<ValidityResultWithData<{ call: Call; nftsToTransfer: ChainNFTs[] }>> {
    try {
      const exchange = new SeaportV14.Exchange(this.chainId);
      const matchParams = this._order.buildMatching();
      if (!this._order.params.signature) {
        throw new Error(`order ${this._order.hash()} is not signed`);
      }

      const txn = await exchange.fillOrderTx(taker, this._order, matchParams);
      const value = BigNumber.from(txn.value ?? '0');

      const call: Call = {
        to: txn.to,
        data: txn.data,
        value: value.toString()
      };

      return {
        isValid: true,
        data: {
          call,
          nftsToTransfer: this._orderData.order.nfts
        }
      };
    } catch (err) {
      logger.error(`seaport`, `unexpected error while getting external fulfillment data ${err}`);
      return {
        isValid: false,
        isTransient: true,
        reason: 'unexpected'
      };
    }

    // return Promise.resolve({ call, nftsToTransfer: this._orderData.order.nfts });
  }

  /**
   * perform order kind specific checks on the order
   */
  protected abstract _checkOrderKindValid(): void;

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
      throw new OrderKindError(`${this.kind}`, this.source, 'unexpected');
    }

    const zones = [ethers.constants.AddressZero, SeaportV14.Addresses.OpenSeaProtectedOffersZone[this.chainId]];
    if (!zones.includes(this._sourceParams.zone)) {
      throw new OrderError('unknown zone', ErrorCode.SeaportZone, this._sourceParams.zone, this.source, 'unsupported');
    }

    if (this._sourceParams.conduitKey !== SeaportBase.Addresses.OpenseaConduitKey[this.chainId]) {
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
    const erc721ItemTypes = new Set([SeaportBase.Types.ItemType.ERC721]); // don't include ERC721 with criteria
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
      if (item.itemType !== SeaportBase.Types.ItemType.ERC721) {
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

    const orderItems: Flow.Types.OrderNFTs[] = Object.entries(nfts).map(([key, value]) => {
      const collection = key;
      const nft = {
        collection,
        tokens: [] as Flow.Types.OrderNFTs['tokens']
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

  async getOperator() {
    const conduit = SeaportBase.Addresses.ConduitController[this.chainId];
    const conduitController = new ethers.Contract(conduit, SeaportConduitControllerAbi, this._provider);

    const makerConduit = BigNumber.from(this._sourceParams.conduitKey).eq(0)
      ? SeaportV14.Addresses.Exchange[this.chainId]
      : await conduitController
          .getConduit(this._sourceParams.conduitKey)
          .then((result: { exists: boolean; conduit: string }) => {
            if (!result.exists) {
              throw new Error('invalid-conduit');
            } else {
              return result.conduit.toLowerCase();
            }
          });

    return makerConduit;
  }

  async getExecutionInfo(taker: string): Promise<Omit<NonNativeMatchExecutionInfo, 'nativeExecutionTransfers'>> {
    const makerConduit = await this.getOperator();

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

  public async getSignature(taker: string): Promise<ValidityResultWithData<string>> {
    let chain;
    let baseUrl;
    switch (this.chainId) {
      case 1:
        chain = 'ethereum';
        baseUrl = 'https://api.opensea.io/';
        break;
      case 5:
        chain = 'goerli';
        baseUrl = 'https://testnets-api.opensea.io/';
        break;
      default:
        logger.error('opensea-signatures', 'Unsupported chain');
        return {
          isValid: false,
          reason: `Unsupported chain`,
          isTransient: false
        };
    }

    const endpoint = this.isSellOrder
      ? `${baseUrl}v2/listings/fulfillment_data`
      : `${baseUrl}v2/offers/fulfillment_data`;

    const order = {
      hash: this._order.hash(),
      chain: chain,
      protocol_address: SeaportV14.Addresses.Exchange[this.chainId]
    };

    const orderBodyData = this.isSellOrder
      ? {
          listing: order
        }
      : { offer: order };
    try {
      const response = await phin({
        method: 'POST',
        url: endpoint,
        headers: {
          'x-api-key': config.marketplaces.opensea.apiKey
        },
        data: {
          ...orderBodyData,
          fulfiller: {
            address: taker
          }
        },
        timeout: 5_000
      });

      if (response.statusCode === 200) {
        const data = JSON.parse(response.body.toString());
        const order = data.fulfillment_data.orders[0];

        return {
          isValid: true,
          data: order.signature
        };
      }

      return {
        isValid: false,
        reason: `Failed to get signature for order ${this._order.hash()} Status Code: ${
          response.statusCode
        }. ${response.body.toString()}`,
        isTransient: true
      };
    } catch (err) {
      logger.error('opensea-signatures', `Request failed ${err}`);
      return {
        isValid: false,
        reason: `Unknown error occurred`,
        isTransient: true
      };
    }
  }
}
