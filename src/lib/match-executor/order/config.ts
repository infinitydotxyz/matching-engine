// import * as Transformers from './order-transformer';
import * as Sdk from '@reservoir0x/sdk';

const infinityConfig = {
  'single-token': {
    enabled: false
  },
  'contract-wide': {
    enabled: false
  },
  complex: {
    enabled: false
  }
};
// } satisfies Record<Sdk.Infinity.Types.OrderKind, unknown>;

const seaportConfig = {
  'single-token': {
    enabled: true,
    builder: Sdk.Seaport.Builders.SingleToken
  },
  'bundle-ask': {
    enabled: false
  },
  'contract-wide': {
    enabled: false
  },
  'token-list': {
    enabled: false
  }
};
// } satisfies Record<Sdk.Seaport.Types.OrderKind, unknown>;

export const config = {
  infinity: {
    source: 'infinity',
    enabled: true,
    kinds: infinityConfig
  },
  seaport: {
    source: 'seaport',
    enabled: true,
    kinds: seaportConfig
  },
  'wyvern-v2': {
    source: 'wyvern-v2',
    enabled: false
  },
  'wyvern-v2.3': {
    source: 'wyvern-v2.3',
    enabled: false
  },
  'looks-rare': {
    source: 'looks-rare',
    enabled: false
  },
  'zeroex-v4-erc721': {
    source: 'zeroex-v4-erc721',
    enabled: false
  },
  'zeroex-v4-erc1155': {
    source: 'zeroex-v4-erc1155',
    enabled: false
  },
  foundation: {
    source: 'foundation',
    enabled: false
  },
  x2y2: {
    source: 'x2y2',
    enabled: false
  },
  rarible: {
    source: 'rarible',
    enabled: false
  },
  'element-erc721': {
    source: 'element-erc721',
    enabled: false
  },
  'element-erc1155': {
    source: 'element-erc1155',
    enabled: false
  },
  quixotic: {
    source: 'quixotic',
    enabled: false
  },
  nouns: {
    source: 'nouns',
    enabled: false
  },
  'zora-v3': {
    source: 'zora-v3',
    enabled: false
  },
  mint: {
    source: 'mint',
    enabled: false
  },
  cryptopunks: {
    source: 'cryptopunks',
    enabled: false
  },
  sudoswap: {
    source: 'sudoswap',
    enabled: false
  },
  universe: {
    source: 'universe',
    enabled: false
  },
  nftx: {
    source: 'nftx',
    enabled: false
  },
  blur: {
    source: 'blur',
    enabled: false
  },
  forward: {
    source: 'forward',
    enabled: false
  }
};
// } satisfies Record<OrderKind, unknown>; // TODO uncomment once ts 4.9 is supported by vscode and dependencies
