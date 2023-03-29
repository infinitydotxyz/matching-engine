
# BASE_URL="https://execution-engine-goerli-dot-nftc-infinity.ue.r.appspot.com"
BASE_URL="https://20230328t094851-dot-execution-engine-goerli-dot-nftc-infinity.ue.r.appspot.com"

# Start execution engine
curl -H "x-api-key: $API_KEY" -X PUT $BASE_URL/execution

