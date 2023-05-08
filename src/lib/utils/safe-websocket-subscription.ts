import { providers } from 'ethers';
import EventEmitter from 'events';
import { nanoid } from 'nanoid';

import { sleep } from '@infinityxyz/lib/utils';

import { getComponentLogger, logger } from '@/common/logger';

const EXPECTED_PONG_BACK = 15000;
const KEEP_ALIVE_CHECK_INTERVAL = 7500;

const initiateSafeWebSocketSubscription = async (
  providerUrl: string,
  logger: ReturnType<typeof getComponentLogger>
): Promise<{ provider: providers.WebSocketProvider; providerValid: Promise<void> }> => {
  const webSocketProvider = new providers.WebSocketProvider(providerUrl);
  let hasClosed = false;
  let hasOpened = false;

  const onReady = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject('Failed to connect to websocket provider');
    }, 30_000);

    webSocketProvider._websocket.on('open', () => {
      if (hasOpened) {
        logger.log(`Received open event after websocket provider has already opened once`);
        return;
      } else if (hasClosed) {
        logger.log(`Received open event after websocket provider has already closed`);
        return;
      }
      hasOpened = true;
      clearTimeout(timeout);
      resolve();
    });
  });

  await onReady;

  // keep the connection alive, terminate if no pong is received
  let pingTimeout: NodeJS.Timeout | undefined;
  const keepAliveInterval = setInterval(() => {
    webSocketProvider._websocket.ping();

    pingTimeout = setTimeout(() => {
      webSocketProvider._websocket.terminate();
      pingTimeout = undefined;
    }, EXPECTED_PONG_BACK);
  }, KEEP_ALIVE_CHECK_INTERVAL);

  webSocketProvider._websocket.on('pong', () => {
    if (pingTimeout) {
      clearTimeout(pingTimeout);
      pingTimeout = undefined;
    }
  });

  const providerValidPromise = new Promise<void>((resolve, reject) => {
    webSocketProvider._websocket.on('message', (data: unknown) => {
      logger.log(`Received message: ${data}`);
    });

    webSocketProvider._websocket.on('close', () => {
      hasClosed = true;
      if (keepAliveInterval) {
        clearInterval(keepAliveInterval);
      }
      if (pingTimeout) {
        clearTimeout(pingTimeout);
        pingTimeout = undefined;
      }

      try {
        webSocketProvider.removeAllListeners();
        webSocketProvider
          .destroy()
          .then(() => {
            logger.error(`WebSocket destroyed`);
          })
          .catch((err) => {
            logger.error(`WebSocket destroy failed: ${err}`);
          });
      } catch (err) {
        logger.error(`WebSocket closing failed: ${err}`);
      }

      reject('Websocket provider closed');
    });
  });

  return {
    provider: webSocketProvider,
    providerValid: providerValidPromise
  };
};

export const safeWebSocketSubscription = async (
  providerUrl: string,
  callback: (provider: providers.WebSocketProvider) => Promise<void>
) => {
  let numConsecutiveFailures = 0;
  for (;;) {
    const id = nanoid(4);
    const logger = getComponentLogger(`websocket-provider:${id}`);
    try {
      const { provider, providerValid } = await initiateSafeWebSocketSubscription(providerUrl, logger);
      await callback(provider);
      numConsecutiveFailures = 0;
      await providerValid;
    } catch (err) {
      numConsecutiveFailures += 1;
      logger.error(`WebSocket subscription failed: ${err}`);
      logger.error(`WebSocket subscription closed. Reconnecting...`);

      if (numConsecutiveFailures > 5) {
        logger.error(`Too many consecutive failures, sleeping...`);
        await sleep(10_000);
      }
      continue;
    }
  }
};

const emitters: { [providerUrl: string]: EventEmitter } = {};

export const getBlockProvider = (providerUrl: string) => {
  if (emitters[providerUrl]) {
    return emitters[providerUrl];
  } else {
    const emitter = new EventEmitter();

    safeWebSocketSubscription(providerUrl, async (provider) => {
      provider.on('block', (blockNumber) => {
        emitter.emit('block', blockNumber);
      });

      await Promise.resolve();
    }).catch((err) => {
      logger.error('block-provider', `Safe WebSocket subscription failed: ${err}`);
    });
    emitters[providerUrl] = emitter;
    return emitter;
  }
};
