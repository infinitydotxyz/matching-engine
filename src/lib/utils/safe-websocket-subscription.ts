import { providers } from 'ethers';

import { sleep } from '@infinityxyz/lib/utils';

import { logger } from '@/common/logger';

const EXPECTED_PONG_BACK = 15000;
const KEEP_ALIVE_CHECK_INTERVAL = 7500;

const initiateSafeWebSocketSubscription = async (
  providerUrl: string
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
        logger.log('websocket-provider', `Received open event after websocket provider has already opened once`);
        return;
      } else if (hasClosed) {
        logger.log('websocket-provider', `Received open event after websocket provider has already closed`);
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
            logger.error('websocket-provider', `WebSocket destroyed`);
          })
          .catch((err) => {
            logger.error('websocket-provider', `WebSocket destroy failed: ${err}`);
          });
      } catch (err) {
        logger.error('websocket-provider', `WebSocket closing failed: ${err}`);
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
    try {
      const { provider, providerValid } = await initiateSafeWebSocketSubscription(providerUrl);
      numConsecutiveFailures = 0;
      const safeCallback = new Promise<void>((resolve) => {
        callback(provider)
          .then(() => {
            resolve();
          })
          .catch((err) => {
            resolve();
          });
      });

      await Promise.race([safeCallback, providerValid]);
      provider._websocket.terminate();
    } catch (err) {
      numConsecutiveFailures += 1;
      logger.error('websocket-provider', `WebSocket subscription failed: ${err}`);
      logger.error('websocket-provider', `WebSocket subscription closed. Reconnecting...`);

      if (numConsecutiveFailures > 5) {
        logger.error('websocket-provider', `Too many consecutive failures, sleeping...`);
        await sleep(10_000);
      }
      continue;
    }
  }
};
