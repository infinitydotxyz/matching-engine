import { Order } from './order';
import { OrderStorage } from './order-storage.abstract';

export class OrderItemStorage extends OrderStorage {
  storageKey = 'order-item';

  getTokenSellsSet(constraints: { complication: string; currency: string; collection: string; tokenId: string }) {
    const scope = 'token-orders';
    const side = 'sell';

    return `scope:${scope}:complication:${constraints.complication}:currency:${constraints.currency}:side:${side}:collection:${constraints.collection}:tokenId:${constraints.tokenId}`;
  }

  getTokenOffersSet(constraints: { complication: string; currency: string; collection: string; tokenId: string }) {
    const scope = 'token-orders';
    const side = 'buy';
    return `scope:${scope}:complication:${constraints.complication}:currency:${constraints.currency}:side:${side}:collection:${constraints.collection}:tokenId:${constraints.tokenId}`;
  }

  getCollectionTokenSellsSet(constraints: { complication: string; currency: string; collection: string }) {
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

  async set(order: Order) {
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

        const tokenSells = this.getTokenSellsSet({
          complication: order.params.complication,
          currency: order.params.currency,
          collection: orderItem.collection,
          tokenId
        });
        const tokenCollectionSells = this.getCollectionTokenSellsSet({
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

    const pipeline = this._db.pipeline();
    for (const item of sets) {
      pipeline.sadd(item, order.id);
    }

    await pipeline.exec();
  }
}
