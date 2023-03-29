import { ethers } from 'ethers';
import { FastifyInstance } from 'fastify';
import PQueue from 'p-queue';

import { ExecutionStatusMatchedExecuted } from '@infinityxyz/lib/types/core';

import { redis } from '@/common/db';
import { logger } from '@/common/logger';
import { config } from '@/config';
import { getOrderbook, getProcesses, startCollection } from '@/lib/collections-queue/start-collection';
import { MatchingEngine } from '@/lib/matching-engine/v1';
import { OrderRelay } from '@/lib/order-relay/v1/order-relay';
import { Order } from '@/lib/orderbook/v1';

import { getExecutionEngine } from '../../../start-execution-engine';

const base = '/matching';

export default async function register(fastify: FastifyInstance) {
  /**
   * get the status of the matching engine for a collection
   */
  fastify.get(`${base}/collection/:collection`, async (request) => {
    const _collection =
      typeof request.params == 'object' &&
      request.params &&
      'collection' in request.params &&
      typeof request.params.collection === 'string'
        ? request.params.collection
        : '';

    if (!ethers.utils.isAddress(_collection)) {
      throw new Error('Invalid collection address');
    }
    const collection = _collection.toLowerCase();

    const processes = getProcesses(collection);
    const { executionEngine } = await getExecutionEngine();
    const { orderbookStorage } = getOrderbook();

    const matchingEngineHealthPromise = processes.matchingEngine.getHealthInfo();
    const orderRelayHealthPromise = processes.orderRelay.getHealthInfo();
    const executionEngineHealthPromise = executionEngine.getHealthInfo();
    const [matchingEngineHealth, orderRelayHealth, executionEngineHealth, matchAverages, executionAverages] =
      await Promise.all([
        matchingEngineHealthPromise,
        orderRelayHealthPromise,
        executionEngineHealthPromise,
        orderbookStorage.executionStorage.getAverageMatchDuration(collection),
        orderbookStorage.executionStorage.getAverageExecutionDuration(collection)
      ]);

    await processes.matchingEngine.close();
    await processes.orderRelay.close();
    await executionEngine.close();

    return {
      isSynced: orderRelayHealth.jobCounts.waiting < 100 && matchingEngineHealth.jobCounts.waiting < 100,
      matchingEngine: matchingEngineHealth,
      orderRelay: orderRelayHealth,
      executionEngine: executionEngineHealth,
      averages: {
        matchingEngine: matchAverages,
        executionEngine: executionAverages
      }
    };
  });

  if (!config.components.api.readonly) {
    /**
     * start the matching engine for a collection
     */
    fastify.put(`${base}/collection/:collection`, (request) => {
      const _collection =
        typeof request.params == 'object' &&
        request.params &&
        'collection' in request.params &&
        typeof request.params.collection === 'string'
          ? request.params.collection
          : '';

      if (!ethers.utils.isAddress(_collection)) {
        throw new Error('Invalid collection address');
      }
      const collection = _collection.toLowerCase();

      startCollection(collection).catch((err) => {
        logger.error(`PUT ${base}/:collection`, `Failed to start collection ${collection} ${JSON.stringify(err)}`);
      });

      return { status: 'ok' };
    });

    fastify.put(`${base}/refresh`, async () => {
      const { orderbookStorage } = getOrderbook();

      const activeOrdersKey = orderbookStorage.activeOrdersOrderedSetKey;
      const activeOrders = await redis.zrange(activeOrdersKey, 0, -1);

      const processes = new Map<string, { matchingEngine: MatchingEngine; orderRelay: OrderRelay }>();
      const getMatchingEngine = (collection: string) => {
        const collectionProcesses = processes.get(collection);
        if (collectionProcesses) {
          return collectionProcesses.matchingEngine;
        } else {
          const collectionProcesses = getProcesses(collection);
          processes.set(collection, collectionProcesses);
          return collectionProcesses.matchingEngine;
        }
      };

      const queue = new PQueue({ concurrency: 5 });
      const chainId = config.env.chainId;
      const triggerMatchingForOrderId = ({ orderId }: { orderId: string }) => {
        queue
          .add(async () => {
            const orderData = await orderbookStorage.getOrder(orderId);
            const collection = orderData?.order?.nfts?.[0]?.collection;
            if (orderData && collection) {
              const matchingEngine = getMatchingEngine(collection);
              const order = Order.getOrderParams(orderId, chainId, orderData.order);
              logger.log('refresh', `Triggering matching for order ${orderId}`);
              await matchingEngine.add({
                id: orderId,
                order: order,
                proposerInitiatedAt: Date.now()
              });
            }
          })
          .catch((err) => {
            logger.error('refresh', `failed to trigger matching for order ${orderId} ${err}`);
          });
      };

      for (const orderId of activeOrders) {
        triggerMatchingForOrderId({ orderId });
      }

      await queue.onIdle();
      for (const item of processes.values()) {
        await item.matchingEngine.close();
        await item.orderRelay.close();
      }

      return { status: 'ok' };
    });
  }

  fastify.get(`${base}/order/:order`, async (request) => {
    const orderId =
      typeof request.params == 'object' &&
      request.params &&
      'order' in request.params &&
      typeof request.params.order === 'string'
        ? request.params.order
        : '';

    if (!ethers.utils.isHexString(orderId)) {
      throw new Error('Invalid order hash');
    }

    const { orderbookStorage } = getOrderbook();

    const persistentStatus = await orderbookStorage.getPersistentExecutionStatus([orderId]);
    if (persistentStatus[0]?.status) {
      return {
        status: persistentStatus[0].status
      };
    }

    const ttsBlockNumber = await orderbookStorage.executionStorage.getTTSBlockNumber();
    const status = await orderbookStorage.getExecutionStatus(orderId, ttsBlockNumber);

    return {
      status
    };
  });

  fastify.post(`${base}/orders`, async (request) => {
    const orderIds: string[] =
      typeof request.body == 'object' && request.body && 'orders' in request.body && Array.isArray(request.body.orders)
        ? request.body.orders
        : [];

    for (const orderId of orderIds) {
      if (typeof orderId !== 'string' || !ethers.utils.isHexString(orderId)) {
        throw new Error('Invalid order hash');
      }
    }
    const { orderbookStorage } = getOrderbook();

    const queue = new PQueue({ concurrency: 20 });

    const partialOrderStatuses = await orderbookStorage.getPersistentExecutionStatus(orderIds);
    const ttsBlockNumber = await orderbookStorage.executionStorage.getTTSBlockNumber();

    const statuses = partialOrderStatuses.map(
      async (item: { orderId: string; status: ExecutionStatusMatchedExecuted | null }) => {
        return await queue.add(async () => {
          if (item.status) {
            return item.status;
          }
          return await orderbookStorage.getExecutionStatus(item.orderId, ttsBlockNumber);
        });
      }
    );

    return {
      data: await Promise.all(statuses)
    };
  });

  /**
   * trigger the matching engine to match orders
   */

  if (!config.components.api.readonly) {
    fastify.put(`${base}/order/:order`, async (request) => {
      const orderId =
        typeof request.params == 'object' &&
        request.params &&
        'order' in request.params &&
        typeof request.params.order === 'string'
          ? request.params.order
          : '';

      if (!ethers.utils.isHexString(orderId)) {
        throw new Error('Invalid order hash');
      }

      const { orderbookStorage } = getOrderbook();

      const order = await orderbookStorage.getOrder(orderId);
      if (!order) {
        return {
          success: false,
          reason: 'failed to find order'
        };
      }

      const collections = orderbookStorage.getOrderCollections(order);
      const orderParams = orderbookStorage.getOrderParams(order);
      const collection = collections[0];
      if (collections.length !== 1) {
        logger.error(`PUT ${base}/order/:order`, `Order ${orderId} has multiple collections`);
        return {
          success: false,
          reason: 'order has multiple collections'
        };
      }

      const processes = getProcesses(collection);
      await processes.matchingEngine.add({ id: orderId, order: orderParams, proposerInitiatedAt: Date.now() });
      await processes.matchingEngine.close();
      await processes.orderRelay.close();

      return {
        success: true
      };
    });
  }

  await Promise.resolve();
}
