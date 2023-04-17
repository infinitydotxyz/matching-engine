import { formatUnits } from 'ethers/lib/utils';
import EventEmitter from 'events';
import { Redis } from 'ioredis';

import {
  BaseExecutionStatusMatchedPendingExecution,
  ChainId,
  ExecutionStatus,
  ExecutionStatusMatchedExecuted,
  ExecutionStatusMatchedExecuting,
  ExecutionStatusMatchedInexecutable,
  ExecutionStatusMatchedInexecutableOfferWETHAllowanceTooLow,
  ExecutionStatusMatchedInexecutableOfferWETHBalanceTooLow,
  ExecutionStatusMatchedNoMatches,
  ExecutionStatusMatchedNotIncluded,
  ExecutionStatusMatchedPendingExecutionGasTooLow,
  ExecutionStatusMatchedPendingExecutionUnknown,
  ExecutionStatusNotFound
} from '@infinityxyz/lib/types/core';
import { ONE_HOUR } from '@infinityxyz/lib/utils';

import { logger } from '@/common/logger';
import { Match } from '@/lib/match-executor/match/types';
import { MatchOperationMetadata } from '@/lib/matching-engine/types';

import { AbstractOrderbookStorage } from '../orderbook-storage.abstract';
import { ExecutionStorage } from './execution-storage';
import { Order } from './order';
import { OrderData } from './types';

interface OrderbookEvents {
  orderMatchRemoved: { orderId: string };
}

export class OrderbookStorage extends AbstractOrderbookStorage<Order, OrderData> {
  public readonly version = 'v1';

  protected _eventEmitter: EventEmitter;

  /**
   * ------ MATCHES ------
   */

  /**
   * a set of all match ids for an order
   */
  getOrderMatchesSet(orderId: string) {
    return `orderbook:${this.version}:chain:${this._chainId}:order-matches:${orderId}`;
  }

  /**
   * key value pairs of an order id to
   * metadata about order match execution
   */
  getOrderMatchOperationMetadataKey(orderId: string) {
    return `orderbook:${this.version}:chain:${this._chainId}:order-matches:${orderId}:metadata`;
  }

  /**
   * an ordered set of order ids that are
   * ordered by the matches max gas price
   */
  get matchesByGasPriceOrderedSetKey() {
    return `orderbook:${this.version}:chain:${this._chainId}:order-matches:by-gas-price`;
  }

  /**
   * key value pairs of a match id to a full match
   */
  getFullMatchKey(matchId: string) {
    return `orderbook:${this.version}:chain:${this._chainId}:order-matches:${matchId}:full`;
  }

  /**
   * ------ ORDERS ------
   */

  getOrderId(order: Order): string {
    return order.id;
  }

  getFullOrderKey(id: string) {
    return `orderbook:${this.version}:chain:${this._chainId}:orders:${id}:full`;
  }

  get storedOrdersSetKey() {
    return `orderbook:${this.version}:chain:${this._chainId}:orders`;
  }

  get activeOrdersOrderedSetKey() {
    return `orderbook:${this.version}:chain:${this._chainId}:order-status:active`;
  }

  get executedOrdersOrderedSetKey() {
    return `orderbook:${this.version}:chain:${this._chainId}:order-status:executed`;
  }

  /**
   * ------ COLLECTION/TOKEN ORDERS ------
   */

  getTokenListingsSet(constraints: { complication: string; currency: string; collection: string; tokenId: string }) {
    const scope = 'token-orders';
    const side = 'sell';

    return `scope:${scope}:complication:${constraints.complication}:side:${side}:collection:${constraints.collection}:tokenId:${constraints.tokenId}`;
  }

  getTokenOffersSet(constraints: { complication: string; currency: string; collection: string; tokenId: string }) {
    const scope = 'token-orders';
    const side = 'buy';
    return `scope:${scope}:complication:${constraints.complication}:side:${side}:collection:${constraints.collection}:tokenId:${constraints.tokenId}`;
  }

  getCollectionTokenListingsSet(constraints: { complication: string; currency: string; collection: string }) {
    const scope = 'collection-token-orders';
    const side = 'sell';

    return `scope:${scope}:complication:${constraints.complication}:side:${side}:collection:${constraints.collection}`;
  }

  getCollectionTokenOffersSet(constraints: {
    complication: string;
    currency: string;
    collection: string;
    tokenId: string;
  }) {
    const scope = 'collection-token-orders';
    const side = 'buy';

    return `scope:${scope}:complication:${constraints.complication}:side:${side}:collection:${constraints.collection}`;
  }

  getCollectionWideOffersSet(constraints: { complication: string; currency: string; collection: string }) {
    const scope = 'collection-wide-orders';
    const side = 'buy';
    return `scope:${scope}:complication:${constraints.complication}:side:${side}:collection:${constraints.collection}`;
  }

  executionStorage: ExecutionStorage;

  constructor(protected _db: Redis, protected _firestore: FirebaseFirestore.Firestore, protected _chainId: ChainId) {
    super();
    this.executionStorage = new ExecutionStorage(_db, this._firestore, this, _chainId);
    this._eventEmitter = new EventEmitter();
  }

  async has(orderId: string): Promise<boolean> {
    const result = await this._db.sismember(this.storedOrdersSetKey, orderId);
    return result === 1;
  }

  async save(_items: OrderData | OrderData[]): Promise<void> {
    const items = Array.isArray(_items) ? _items : [_items];
    for (const item of items) {
      try {
        let txn = this._db.multi();

        const order = new Order(Order.getOrderParams(item.id, this._chainId, item.order));
        const orderItemSets = this._getOrderItemSets(order);
        const fullOrder = JSON.stringify(item);
        if (item.status === 'active') {
          logger.log('orderbook-storage', `Adding order ${item.id} to active orders`);
          txn = txn.sadd(this.storedOrdersSetKey, item.id).zadd(this.activeOrdersOrderedSetKey, -1, item.id);
          txn = txn.set(this.getFullOrderKey(item.id), fullOrder);

          for (const set of orderItemSets.sets) {
            txn = txn.zadd(set, orderItemSets.orderScore, item.id);
          }
        } else {
          logger.log('orderbook-storage', `Removing order ${item.id} from active orders`);
          txn.srem(this.storedOrdersSetKey, item.id).zrem(this.activeOrdersOrderedSetKey, item.id);
          txn.del(this.getFullOrderKey(item.id), this.getOrderMatchOperationMetadataKey(item.id));

          /**
           * set these to expire in one hour so we have time to process them if the order was executed
           */
          const pending = this.executionStorage.getPendingOrderExecutionKey(item.id);
          const notIncluded = this.executionStorage.getNotIncludedOrderExecutionKey(item.id);
          const executed = this.executionStorage.getExecutedOrderExecutionKey(item.id);
          const inexecutable = this.executionStorage.getInexecutableOrderExecutionKey(item.id);
          txn.pexpire(pending, ONE_HOUR);
          txn.pexpire(notIncluded, ONE_HOUR);
          txn.pexpire(executed, ONE_HOUR);
          txn.pexpire(inexecutable, ONE_HOUR);

          for (const set of orderItemSets.sets) {
            txn.zrem(set, item.id);
          }
          /**
           * delete the set,
           * for every order match in the set, delete the full match
           */
          const orderMatchesSet = this.getOrderMatchesSet(item.id);
          const matches = await this._db.smembers(orderMatchesSet);

          if (matches.length > 0) {
            logger.log('orderbook-storage', `Removing matches: ${matches.join(', \n')} for order ${item.id}`);
            txn.del(matches.map(this.getFullMatchKey.bind(this)));
            txn.zrem(this.matchesByGasPriceOrderedSetKey, ...matches);
            for (const match of matches) {
              const matchOrderMatchesSet = this.getOrderMatchesSet(match);
              const ids = match.split(':').filter((id) => id !== item.id);
              txn.srem(matchOrderMatchesSet, item.id);
              for (const id of ids) {
                this.emit('orderMatchRemoved', { orderId: id });
              }
            }
          }
          txn.del(orderMatchesSet);
        }
        const results = await txn.exec();
        if (results) {
          for (const [error] of results) {
            if (error) {
              logger.error('orderbook-storage', `Failed to save order ${item.id} - ${item.status} ${error}`);
            }
          }
        }

        logger.log('orderbook-storage', `Handled order ${item.id}`);
      } catch (err) {
        logger.error('orderbook-storage', `Failed to save order event ${item.id} - ${item.status} ${err}`);
      }
    }
  }

  protected _getOrderItemSets(order: Order) {
    const orderItem = order.getOrderItem();

    const sets: string[] = [];
    const collections: Set<string> = new Set();

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
        collections.add(orderItem.collection);
        break;
      }
      case 'buy:collection': {
        const collectionWideOffers = this.getCollectionWideOffersSet({
          complication: order.params.complication,
          currency: order.params.currency,
          collection: orderItem.collection
        });
        sets.push(collectionWideOffers);
        collections.add(orderItem.collection);
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
        collections.add(orderItem.collection);
        break;
      }
      case 'sell:collection': {
        throw new Error('Unsupported order side');
      }
    }

    const orderScore = order.params.startPriceEth;

    return { sets, orderScore, collections: Array.from(collections) };
  }

  async getOrder(id: string): Promise<OrderData | null> {
    const fullOrder = await this._db.get(this.getFullOrderKey(id));
    if (fullOrder) {
      try {
        return JSON.parse(fullOrder);
      } catch (err) {
        return null;
      }
    }
    return null;
  }

  getOrderCollections(order: OrderData) {
    const collections = this._getOrderItemSets(
      new Order(Order.getOrderParams(order.id, this._chainId, order.order))
    ).collections;

    return collections;
  }

  getOrderParams(order: OrderData) {
    return Order.getOrderParams(order.id, this._chainId, order.order);
  }

  async getOrderMatches(id: string, cursor = '0') {
    const set = this.getOrderMatchesSet(id);
    const numMatches = await this._db.scard(set);
    const [updatedCursor, matches] = await this._db.sscan(set, cursor);

    if (matches.length > 0) {
      const fullMatches = await this._db.mget(matches.map(this.getFullMatchKey.bind(this)));
      const parsedMatches = fullMatches.map((match) => (match ? JSON.parse(match) : null)) as Match[];

      return {
        cursor: updatedCursor,
        numMatches,
        matches: parsedMatches
      };
    }
    return {
      cursor: updatedCursor,
      numMatches,
      matches: [] as Match[]
    };
  }

  async getStatus(id: string): Promise<'active' | 'executed' | 'not-found'> {
    const exists = await this.has(id);
    if (!exists) {
      return 'not-found';
    }

    const scores = await this._db.zmscore(this.executedOrdersOrderedSetKey, id);
    const score = scores[0];

    if (score) {
      return 'executed';
    }
    return 'active';
  }

  async getOrderMatchOperationMetadata(id: string): Promise<MatchOperationMetadata | null> {
    const result = await this._db.get(this.getOrderMatchOperationMetadataKey(id));
    try {
      return JSON.parse(result ?? '');
    } catch (err) {
      return null;
    }
  }

  async getExecutionStatus(orderId: string, ttsBlockNumber: number): Promise<ExecutionStatus> {
    const matchOperationMetadata = await this.getOrderMatchOperationMetadata(orderId);
    if (!matchOperationMetadata) {
      const status = await this.getStatus(orderId);

      switch (status) {
        case 'not-found': {
          const notFoundStatus: ExecutionStatusNotFound = {
            id: orderId,
            status: 'not-found'
          };
          return notFoundStatus;
        }
        case 'active': {
          logger.warn('execution-status', `Order ${orderId} is active but has no match operation metadata`);
          const notFoundStatus: ExecutionStatusNotFound = {
            id: orderId,
            status: 'not-found'
          };
          return notFoundStatus;
        }
        case 'executed': {
          logger.warn('execution-status', `Order ${orderId} is executed but has no match operation metadata`);
          const notFoundStatus: ExecutionStatusNotFound = {
            id: orderId,
            status: 'not-found'
          };
          return notFoundStatus;
        }
      }
    }

    if (matchOperationMetadata.validMatches === 0) {
      const noMatchesStatus: ExecutionStatusMatchedNoMatches = {
        id: orderId,
        status: 'matched-no-matches',
        matchInfo: {
          side: matchOperationMetadata.side,
          proposerInitiatedAt: matchOperationMetadata.timing.proposerInitiatedAt,
          matchedAt: matchOperationMetadata.timing.matchedAt
        }
      };
      return noMatchesStatus;
    }

    const executionStatus = await this.executionStorage.getOrderExecutionStatus(orderId, ttsBlockNumber);
    if (!executionStatus) {
      const minimumMaxGasPriceGwei = await this.getOrderMatchMinMaxGasPrice(orderId);
      const mostRecentBlock = await this.executionStorage.getMostRecentBlock();
      const maxFeePerGasGwei = parseFloat(formatUnits(mostRecentBlock?.maxFeePerGas ?? '0', 'gwei').toString());
      const base: BaseExecutionStatusMatchedPendingExecution = {
        id: orderId,
        status: 'matched-pending-execution',
        matchInfo: {
          side: matchOperationMetadata.side,
          proposerInitiatedAt: matchOperationMetadata.timing.proposerInitiatedAt,
          matchedAt: matchOperationMetadata.timing.matchedAt
        }
      };

      if (minimumMaxGasPriceGwei != null && minimumMaxGasPriceGwei < maxFeePerGasGwei) {
        const pendingExecutionStatus: ExecutionStatusMatchedPendingExecutionGasTooLow = {
          ...base,
          reason: 'gas-too-low',
          bestMatchMaxFeePerGasGwei: minimumMaxGasPriceGwei.toString(),
          currentMaxFeePerGasGwei: maxFeePerGasGwei.toString()
        };
        return pendingExecutionStatus;
      }

      const pendingExecutionStatus: ExecutionStatusMatchedPendingExecutionUnknown = {
        ...base,
        reason: 'unknown'
      };
      return pendingExecutionStatus;
    }

    switch (executionStatus.status) {
      case 'pending': {
        const executing: ExecutionStatusMatchedExecuting = {
          id: orderId,
          status: 'matched-executing',
          matchInfo: {
            side: matchOperationMetadata.side,
            proposerInitiatedAt: matchOperationMetadata.timing.proposerInitiatedAt,
            matchedAt: matchOperationMetadata.timing.matchedAt
          },
          executionInfo: {
            initiatedAt: executionStatus.timing.initiatedAt,
            matchId: executionStatus.matchId,
            matchedOrderId: executionStatus.matchedOrderId,
            blockNumber: executionStatus.block.number,
            baseFeePerGas: executionStatus.block.baseFeePerGas,
            maxFeePerGas: executionStatus.block.maxFeePerGas,
            maxPriorityFeePerGas: executionStatus.block.maxPriorityFeePerGas
          }
        };

        return executing;
      }
      case 'inexecutable': {
        const isWETHBalanceTooLow = executionStatus?.reason?.includes?.('WETH balance of');
        const isWETHAllowanceTooLow = executionStatus?.reason?.includes?.('WETH allowance of');
        if (isWETHBalanceTooLow) {
          const inexecutableStatus: ExecutionStatusMatchedInexecutableOfferWETHBalanceTooLow = {
            id: orderId,
            status: 'matched-inexecutable-offer-weth-too-low',
            matchInfo: {
              side: matchOperationMetadata.side,
              proposerInitiatedAt: matchOperationMetadata.timing.proposerInitiatedAt,
              matchedAt: matchOperationMetadata.timing.matchedAt
            },
            executionInfo: {
              reason: executionStatus.reason,
              initiatedAt: executionStatus.timing.initiatedAt,
              matchedOrderId: executionStatus.matchedOrderId,
              matchId: executionStatus.matchId,
              blockNumber: executionStatus.block.number,
              baseFeePerGas: executionStatus.block.baseFeePerGas,
              maxFeePerGas: executionStatus.block.maxFeePerGas,
              maxPriorityFeePerGas: executionStatus.block.maxPriorityFeePerGas
            }
          };

          return inexecutableStatus;
        } else if (isWETHAllowanceTooLow) {
          const inexecutableStatus: ExecutionStatusMatchedInexecutableOfferWETHAllowanceTooLow = {
            id: orderId,
            status: 'matched-inexecutable-offer-weth-allowance-too-low',
            matchInfo: {
              side: matchOperationMetadata.side,
              proposerInitiatedAt: matchOperationMetadata.timing.proposerInitiatedAt,
              matchedAt: matchOperationMetadata.timing.matchedAt
            },
            executionInfo: {
              reason: executionStatus.reason,
              initiatedAt: executionStatus.timing.initiatedAt,
              matchedOrderId: executionStatus.matchedOrderId,
              matchId: executionStatus.matchId,
              blockNumber: executionStatus.block.number,
              baseFeePerGas: executionStatus.block.baseFeePerGas,
              maxFeePerGas: executionStatus.block.maxFeePerGas,
              maxPriorityFeePerGas: executionStatus.block.maxPriorityFeePerGas
            }
          };

          return inexecutableStatus;
        }

        const inexecutableStatus: ExecutionStatusMatchedInexecutable = {
          id: orderId,
          status: 'matched-inexecutable',
          matchInfo: {
            side: matchOperationMetadata.side,
            proposerInitiatedAt: matchOperationMetadata.timing.proposerInitiatedAt,
            matchedAt: matchOperationMetadata.timing.matchedAt
          },
          executionInfo: {
            reason: executionStatus.reason,
            initiatedAt: executionStatus.timing.initiatedAt,
            matchedOrderId: executionStatus.matchedOrderId,
            matchId: executionStatus.matchId,
            blockNumber: executionStatus.block.number,
            baseFeePerGas: executionStatus.block.baseFeePerGas,
            maxFeePerGas: executionStatus.block.maxFeePerGas,
            maxPriorityFeePerGas: executionStatus.block.maxPriorityFeePerGas
          }
        };
        return inexecutableStatus;
      }
      case 'not-included': {
        const notIncludedStatus: ExecutionStatusMatchedNotIncluded = {
          id: orderId,
          status: 'matched-executing-not-included',
          matchInfo: {
            side: matchOperationMetadata.side,
            proposerInitiatedAt: matchOperationMetadata.timing.proposerInitiatedAt,
            matchedAt: matchOperationMetadata.timing.matchedAt
          },
          executionInfo: {
            initiatedAt: executionStatus.timing.initiatedAt,
            receiptReceivedAt: executionStatus.timing.receiptReceivedAt,
            matchedOrderId: executionStatus.matchedOrderId,
            matchId: executionStatus.matchId,
            blockNumber: executionStatus.block.number,
            baseFeePerGas: executionStatus.block.baseFeePerGas,
            maxFeePerGas: executionStatus.block.maxFeePerGas,
            maxPriorityFeePerGas: executionStatus.block.maxPriorityFeePerGas,
            effectiveGasPrice: executionStatus.effectiveGasPrice,
            gasUsed: executionStatus.gasUsed,
            cumulativeGasUsed: executionStatus.cumulativeGasUsed
          }
        };
        return notIncludedStatus;
      }
      case 'executed': {
        const executedStatus: ExecutionStatusMatchedExecuted = {
          id: orderId,
          status: 'matched-executed',
          matchInfo: {
            side: matchOperationMetadata.side,
            proposerInitiatedAt: matchOperationMetadata.timing.proposerInitiatedAt,
            matchedAt: matchOperationMetadata.timing.matchedAt
          },
          executionInfo: {
            initiatedAt: executionStatus.timing.initiatedAt,
            receiptReceivedAt: executionStatus.timing.receiptReceivedAt,
            matchedOrderId: executionStatus.matchedOrderId,
            matchId: executionStatus.matchId,
            blockNumber: executionStatus.block.number,
            baseFeePerGas: executionStatus.block.baseFeePerGas,
            maxFeePerGas: executionStatus.block.maxFeePerGas,
            maxPriorityFeePerGas: executionStatus.block.maxPriorityFeePerGas,
            effectiveGasPrice: executionStatus.effectiveGasPrice,
            gasUsed: executionStatus.gasUsed,
            cumulativeGasUsed: executionStatus.cumulativeGasUsed,
            txHash: executionStatus.txHash,
            blockTimestampSeconds: executionStatus.timing.blockTimestamp
          }
        };
        return executedStatus;
      }
    }
  }

  async getOrderMatchMinMaxGasPrice(orderId: string) {
    const orderMatchesKey = this.getOrderMatchesSet(orderId);
    const orderMatches = await this._db.smembers(orderMatchesKey);

    if (orderMatches.length === 0) {
      return null;
    }
    const pipeline = this._db.pipeline();
    for (const orderMatchId of orderMatches) {
      const matchMaxGasPriceKey = this.matchesByGasPriceOrderedSetKey;
      pipeline.zscore(matchMaxGasPriceKey, orderMatchId);
    }

    const results = await pipeline.exec();

    if (!results) {
      throw new Error(`Failed to get max gas price for order ${orderId}`);
    }

    const minMaxGasPriceGwei = results.reduce((acc, [err, res]) => {
      if (err) {
        throw err;
      }

      if (typeof res === 'string') {
        res = parseFloat(res);
      } else if (!res) {
        return acc;
      }

      if (typeof res !== 'number') {
        throw new Error(`Unexpected result type ${res}`);
      }
      return res < acc ? res : acc;
    }, Infinity);

    if (minMaxGasPriceGwei === Infinity) {
      return null;
    }

    return minMaxGasPriceGwei;
  }

  async getPersistentExecutionStatus(orderIds: string[]) {
    const refs = orderIds.map((orderId) => {
      return this._firestore
        .collection('executedOrders')
        .doc(orderId) as FirebaseFirestore.DocumentReference<ExecutionStatusMatchedExecuted>;
    });

    if (refs.length === 0) {
      return [];
    }

    const orderStatuses = await (
      this._firestore.getAll(...refs) as Promise<FirebaseFirestore.DocumentSnapshot<ExecutionStatusMatchedExecuted>[]>
    ).then((snaps: FirebaseFirestore.DocumentSnapshot<ExecutionStatusMatchedExecuted>[]) => {
      return snaps.map((snap) => {
        return { orderId: snap.id, status: snap.data() ?? null };
      });
    });

    return orderStatuses;
  }

  protected emit<K extends keyof OrderbookEvents>(event: K, data: OrderbookEvents[K]) {
    this._eventEmitter.emit(event, data);
  }

  public on<K extends keyof OrderbookEvents>(event: K, handler: (data: OrderbookEvents[K]) => void) {
    this._eventEmitter.on(event, handler);
  }

  public off<K extends keyof OrderbookEvents>(event: K, handler: (data: OrderbookEvents[K]) => void) {
    this._eventEmitter.off(event, handler);
  }
}
