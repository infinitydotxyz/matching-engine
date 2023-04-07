
BASE_URL="https://execution-engine-goerli-dot-nftc-infinity.ue.r.appspot.com"
# BASE_URL="https://20230329t081349-dot-execution-engine-goerli-dot-nftc-infinity.ue.r.appspot.com"

# Start execution engine
curl -H "x-api-key: $API_KEY" -X PUT $BASE_URL/execution

