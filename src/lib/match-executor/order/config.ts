import * as Seaport from './seaport';
import * as SeaportV14 from './seaport-v1.4';
import * as SeaportV15 from './seaport-v1.5';

const seaportConfig = {
  'single-token': {
    enabled: true,
    order: Seaport.SingleTokenOrder
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

const seaportV14Config = {
  'single-token': {
    enabled: true,
    order: SeaportV14.SingleTokenOrder
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

const seaportV15Config = {
  'single-token': {
    enabled: true,
    order: SeaportV15.SingleTokenOrder
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

export const config = {
  seaport: {
    source: 'seaport',
    enabled: true,
    kinds: seaportConfig
  },
  'seaport-v1.4': {
    source: 'seaport-v1.4',
    enabled: true,
    kinds: seaportV14Config
  },
  'seaport-v1.5': {
    source: 'seaport-v1.5',
    enabled: true,
    kinds: seaportV15Config
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
  manifold: {
    source: 'manifold',
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
