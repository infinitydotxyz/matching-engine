import Redis from 'ioredis';
import Redlock from 'redlock';

import { config } from '@/config';

const connectionUrl = config.components.api.readonly ? config.redis.readConnectionUrl : config.redis.connectionUrl;

export const redis = new Redis(connectionUrl, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false
});

export const redlock = new Redlock([redis.duplicate()], { retryCount: 0 });
