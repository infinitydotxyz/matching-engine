import { ethers } from 'ethers';

import { logger } from '@/common/logger';

// https://github.com/ethers-io/ethers.js/issues/1053#issuecomment-808736570
export const safeWebSocketSubscription = (
  providerUrl: string,
  callback: (provider: ethers.providers.WebSocketProvider) => Promise<void>
) => {
  const webSocketProvider = new ethers.providers.WebSocketProvider(providerUrl);
  webSocketProvider.on('error', (error) => {
    logger.error('websocket-provider', `WebSocket subscription failed: ${error}`);
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  webSocketProvider._websocket.on('error', (error: any) => {
    logger.error('websocket-provider', `WebSocket subscription failed: ${error}`);
  });

  let pingTimeout: NodeJS.Timeout | undefined;
  let keepAliveInterval: NodeJS.Timer | undefined;

  const EXPECTED_PONG_BACK = 15000;
  const KEEP_ALIVE_CHECK_INTERVAL = 7500;
  webSocketProvider._websocket.on('open', async () => {
    keepAliveInterval = setInterval(() => {
      webSocketProvider._websocket.ping();

      pingTimeout = setTimeout(() => {
        webSocketProvider._websocket.terminate();
      }, EXPECTED_PONG_BACK);
    }, KEEP_ALIVE_CHECK_INTERVAL);

    await callback(webSocketProvider);
  });

  webSocketProvider._websocket.on('close', () => {
    if (keepAliveInterval) {
      clearInterval(keepAliveInterval);
    }
    if (pingTimeout) {
      clearTimeout(pingTimeout);
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
    logger.error('websocket-provider', `WebSocket subscription closed. Reconnecting...`);
    safeWebSocketSubscription(providerUrl, callback);
  });

  webSocketProvider._websocket.on('pong', () => {
    if (pingTimeout) {
      clearInterval(pingTimeout);
    }
  });
};
