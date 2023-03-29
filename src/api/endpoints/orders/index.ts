import { ethers } from 'ethers';
import { FastifyInstance } from 'fastify';

import { getOrderbook } from '@/lib/collections-queue/start-collection';

const base = '/orders';

export default async function register(fastify: FastifyInstance) {
  /**
   * get a full order
   */
  fastify.get(`${base}/:order`, async (request) => {
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

    const fullOrder = await orderbookStorage.getOrder(orderId);
    if (fullOrder) {
      return {
        order: fullOrder
      };
    }

    return {
      order: null
    };
  });

  /**
   * get an order's matches
   */
  fastify.get(`${base}/:order/matches`, async (request) => {
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

    const cursor =
      typeof request.query == 'object' &&
      request.query &&
      'cursor' in request.query &&
      typeof request.query.cursor === 'string'
        ? request.query.cursor
        : '0';

    const { orderbookStorage } = getOrderbook();

    const matches = await orderbookStorage.getOrderMatches(orderId, cursor);
    return {
      matches
    };
  });

  await Promise.resolve();
}
