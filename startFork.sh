source ./.anvil.env
BLOCK_HEX=$(cast rpc eth_blockNumber --rpc-url mainnet | sed 's/"//g')
BLOCK=$(printf "%d" "$BLOCK_HEX")
anvil --fork-block-number $BLOCK --no-rate-limit --chain-id 1 --steps-tracing --rpc-url $ANVIL_RPC_URL