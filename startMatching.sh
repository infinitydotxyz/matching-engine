
BASE_URL="https://matching-engine-goerli-dot-nftc-infinity.ue.r.appspot.com"
# BASE_URL="https://20230328t094750-dot-matching-engine-goerli-dot-nftc-infinity.ue.r.appspot.com"

# Goeril Azuki
curl -H "x-api-key: $API_KEY" -X PUT $BASE_URL/matching/collection/0x10b8b56d53bfa5e374f38e6c0830bad4ebee33e6

# BAYC
curl -H "x-api-key: $API_KEY" -X PUT $BASE_URL/matching/collection/0xe29f8038d1a3445ab22ad1373c65ec0a6e1161a4

# MAYC
curl -H "x-api-key: $API_KEY" -X PUT $BASE_URL/matching/collection/0x09e8617f391c54530cc2d3762ceb1da9f840c5a3

# Moonbirds 
curl -H "x-api-key: $API_KEY" -X PUT $BASE_URL/matching/collection/0x06f36c3f77973317bea50363a0f66646bced7319

# cyberkongz
curl -H "x-api-key: $API_KEY" -X PUT $BASE_URL/matching/collection/0xfc4cd5d102f296069a05f92843f3451c44073b22

# Gowls
curl -H "x-api-key: $API_KEY" -X PUT $BASE_URL/matching/collection/0x29b969f3aba9a1e2861a3190ec9057b3989fe85d
