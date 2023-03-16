# Load environment variables from .env file
# if [ -f .env.prod.goerli.deploy ]; then
#     export $(grep -v '^#' .env | xargs)
# else
#     echo "Error: .env file not found."
#     exit 1
# fi

# Goeril Azuki
curl -H "x-api-key: $API_KEY" -X PUT https://matching-engine-goerli-dot-nftc-infinity.ue.r.appspot.com/matching/collection/0x10b8b56d53bfa5e374f38e6c0830bad4ebee33e6

# Gowls
curl -H "x-api-key: $API_KEY" -X PUT https://matching-engine-goerli-dot-nftc-infinity.ue.r.appspot.com/matching/collection/0x29b969f3aba9a1e2861a3190ec9057b3989fe85d

# Start execution engine
curl -H "x-api-key: $API_KEY" -X PUT https://execution-engine-goerli-dot-nftc-infinity.ue.r.appspot.com/execution

