import { Redis } from 'ioredis';

import { ChainId } from '@infinityxyz/lib/types/core';

import { AbstractOrderbookStorage } from '../orderbook-storage.abstract';
import { Order } from './order';
import { Status } from './types';

export class OrderbookStorage extends AbstractOrderbookStorage<Order, Status> {
  public readonly version = 'v1';

  getOrderMatchesOrderedSet(orderId: string) {
    return `orderbook:${this.version}:chain:${this._chainId}:order-matches:${orderId}`;
  }

  get storedOrdersSetKey() {
    return `orderbook:${this.version}:chain:${this._chainId}:orders`;
  }

  get activeOrdersOrderedSetKey() {
    return `orderbook:${this.version}:chain:${this._chainId}:order-status:active`;
  }

  getOrderId(order: Order): string {
    return order.id;
  }

  getTokenListingsSet(constraints: { complication: string; currency: string; collection: string; tokenId: string }) {
    const scope = 'token-orders';
    const side = 'sell';

    return `scope:${scope}:complication:${constraints.complication}:currency:${constraints.currency}:side:${side}:collection:${constraints.collection}:tokenId:${constraints.tokenId}`;
  }

  getTokenOffersSet(constraints: { complication: string; currency: string; collection: string; tokenId: string }) {
    const scope = 'token-orders';
    const side = 'buy';
    return `scope:${scope}:complication:${constraints.complication}:currency:${constraints.currency}:side:${side}:collection:${constraints.collection}:tokenId:${constraints.tokenId}`;
  }

  getCollectionTokenListingsSet(constraints: { complication: string; currency: string; collection: string }) {
    const scope = 'collection-token-orders';
    const side = 'sell';

    return `scope:${scope}:complication:${constraints.complication}:currency:${constraints.currency}:side:${side}:collection:${constraints.collection}`;
  }

  getCollectionTokenOffersSet(constraints: {
    complication: string;
    currency: string;
    collection: string;
    tokenId: string;
  }) {
    const scope = 'collection-token-orders';
    const side = 'buy';

    return `scope:${scope}:complication:${constraints.complication}:currency:${constraints.currency}:side:${side}:collection:${constraints.collection}`;
  }

  getCollectionWideOffersSet(constraints: { complication: string; currency: string; collection: string }) {
    const scope = 'collection-wide-orders';
    const side = 'buy';
    return `scope:${scope}:complication:${constraints.complication}:currency:${constraints.currency}:side:${side}:collection:${constraints.collection}`;
  }

  constructor(protected _db: Redis, protected _chainId: ChainId) {
    super();
  }

  async has(orderId: string): Promise<boolean> {
    const result = await this._db.sismember(this.storedOrdersSetKey, orderId);
    return result === 1;
  }

  async save(_items: { order: Order; status: Status } | { order: Order; status: Status }[]): Promise<void> {
    const items = Array.isArray(_items) ? _items : [_items];

    let txn = this._db.multi();

    for (const item of items) {
      const orderItemSets = this._getOrderItemSets(item.order);
      if (item.status === 'active') {
        txn = txn.sadd(this.storedOrdersSetKey, item.order.id).zadd(this.activeOrdersOrderedSetKey, -1, item.order.id);

        for (const set of orderItemSets.sets) {
          txn = txn.zadd(set, orderItemSets.orderScore, item.order.id);
        }
      } else {
        txn = txn.srem(this.storedOrdersSetKey, item.order.id).zrem(this.activeOrdersOrderedSetKey, item.order.id);

        for (const set of orderItemSets.sets) {
          txn = txn.zrem(set, item.order.id);
        }

        // delete the order matches for this order
        // execution engine will handle removing invalid matches from other orders
        const orderMatches = this.getOrderMatchesOrderedSet(item.order.id);
        txn = txn.del(orderMatches);
      }
    }
    await txn.exec();
  }

  protected _getOrderItemSets(order: Order) {
    const orderItem = order.getOrderItem();

    const sets: string[] = [];

    switch (`${order.params.side}:${'tokenId' in orderItem ? 'token' : 'collection'}`) {
      case 'buy:token': {
        const tokenId = (orderItem as { collection: string; tokenId: string }).tokenId;
        const tokenOffers = this.getTokenOffersSet({
          complication: order.params.complication,
          currency: order.params.currency,
          collection: orderItem.collection,
          tokenId
        });
        const tokenCollectionOffers = this.getCollectionTokenOffersSet({
          complication: order.params.complication,
          currency: order.params.currency,
          collection: orderItem.collection,
          tokenId
        });

        sets.push(tokenOffers, tokenCollectionOffers);
        break;
      }
      case 'buy:collection': {
        const collectionWideOffers = this.getCollectionWideOffersSet({
          complication: order.params.complication,
          currency: order.params.currency,
          collection: orderItem.collection
        });
        sets.push(collectionWideOffers);
        break;
      }
      case 'sell:token': {
        const tokenId = (orderItem as { collection: string; tokenId: string }).tokenId;

        const tokenSells = this.getTokenListingsSet({
          complication: order.params.complication,
          currency: order.params.currency,
          collection: orderItem.collection,
          tokenId
        });
        const tokenCollectionSells = this.getCollectionTokenListingsSet({
          complication: order.params.complication,
          currency: order.params.currency,
          collection: orderItem.collection
        });
        sets.push(tokenSells, tokenCollectionSells);
        break;
      }
      case 'sell:collection': {
        throw new Error('Unsupported order side');
      }
    }

    const orderScore = order.params.startPriceEth;

    return { sets, orderScore };
  }
}
