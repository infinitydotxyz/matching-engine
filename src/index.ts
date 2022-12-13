import { config } from '@/config';

import { logger } from './common/logger';

process.on('unhandledRejection', (error) => {
  logger.error('process', `Unhandled rejection: ${error}`);
});

logger.info('process', `Starting server with config: ${config.env.mode}`);
