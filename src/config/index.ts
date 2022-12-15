const getEnvVariable = (key: string, required = true): string => {
  if (key in process.env && process.env[key] != null && typeof process.env[key] === 'string') {
    return process.env[key] as string;
  } else if (required) {
    throw new Error(`Missing required environment variable ${key}`);
  }

  return '';
};

const getMode = (): 'dev' | 'prod' => {
  const env = getEnvVariable('INFINITY_NODE_ENV');
  if (!env) {
    return 'prod';
  } else if (env === 'dev' || env === 'prod') {
    return env;
  }

  throw new Error(`Invalid env mode ${env}`);
};

export const config = {
  env: {
    mode: getMode(),
    chainId: getEnvVariable('CHAIN_ID', true)
  },
  redis: {
    connectionUrl: getEnvVariable('REDIS_URL')
  }
};
