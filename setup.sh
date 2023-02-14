#!/bin/bash
cast rpc evm_setAutomine true > /dev/null
MAX_UINT_256="115792089237316195423570985008687907853269984665640564039457584007913129639935";

# Accounts
export ACCOUNT_0=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
export ACCOUNT_1=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
export ACCOUNT_2=0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a
export ACCOUNT_3=0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6
export ACCOUNT_4=0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a
export ACCOUNT_5=0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba
export ACCOUNT_6=0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e
export ACCOUNT_7=0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356
export ACCOUNT_8=0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97
export ACCOUNT_9=0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6

# Contracts
EXCHANGE="0xf1000142679a6a57abd2859d18f8002216b0ac2b"
WETH="0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"
SEAPORT="0x00000000006c3852cbEf3e08E8dF289169EdE581"

EXCHANGE_OWNER=`cast call $EXCHANGE "owner()(address)"`
echo "Exchange Owner $EXCHANGE_OWNER"
echo "Impersonating Exchange owner"
cast rpc anvil_impersonateAccount $EXCHANGE_OWNER > /dev/null

export TEST=$ACCOUNT_8
export INITIATOR=$ACCOUNT_9;
INITIATOR_ADDR=`cast wallet address $INITIATOR`
export ERC721_OWNER=$ACCOUNT_5;

echo "Depositing WETH to test account"
cast send $WETH "deposit()" --value 1ether --private-key $TEST > /dev/null

echo "Deploying match executor..."
_MATCH_EXEC_OUTPUT="_match_executor_deploy.txt"
forge create --constructor-args "$EXCHANGE" "$INITIATOR_ADDR" --private-key $INITIATOR contracts/core/FlowMatchExecutor.sol:FlowMatchExecutor > $_MATCH_EXEC_OUTPUT
MATCH_EXECUTOR=`grep "Deployed to:" $_MATCH_EXEC_OUTPUT | cut -d ':' -f 2`
echo "Match executor deployed to $MATCH_EXECUTOR"
rm $_MATCH_EXEC_OUTPUT


# Update match executor on exchange
echo "Updating match executor..."
cast send $EXCHANGE_OWNER --value 1ether --private-key $ACCOUNT_4 > /dev/null
cast send $EXCHANGE "updateMatchExecutor(address)" $MATCH_EXECUTOR --from $EXCHANGE_OWNER --gas-limit 30000000 > /dev/null
echo "Updated match executor"

# Enable exchanges
echo "Enabling exchanges..."
cast send $MATCH_EXECUTOR "addEnabledExchange(address)" $EXCHANGE --private-key $INITIATOR > /dev/null
cast send $MATCH_EXECUTOR "addEnabledExchange(address)" $SEAPORT --private-key $INITIATOR > /dev/null
echo "Enabled exchanges"

echo "Funding match executor..."
cast send $MATCH_EXECUTOR --value 100ether --private-key $ACCOUNT_7 > /dev/null
echo "Funded match executor"

# Deploy test erc721
echo "Deploying ERC721..."
_ERC_721_OUTPUT="_erc721_deploy.txt"
forge create --constructor-args "FLOW NFT" "FLOW" --private-key $ERC721_OWNER contracts/mocks/MockERC721.sol:MockERC721 > $_ERC_721_OUTPUT
ERC721=`grep "Deployed to:" $_ERC_721_OUTPUT | cut -d ':' -f 2`
echo "ERC721 deployed to $ERC721"
rm $_ERC_721_OUTPUT

echo "Setting approval for ERC721 transfers"
cast send $ERC721 "setApprovalForAll(address, bool)" $SEAPORT true --private-key $ERC721_OWNER > /dev/null
echo "Setting approval to spend WETH"
cast send $WETH "approve(address, uint256)" $EXCHANGE $MAX_UINT_256 --private-key $TEST > /dev/null

echo "
INITIATOR_KEY='$INITIATOR'
MATCH_EXECUTOR_ADDRESS='$MATCH_EXECUTOR'
EXCHANGE_ADDRESS='$EXCHANGE'
CHAIN_ID='1'
HTTP_PROVIDER_URL='http://127.0.0.1:8545/'
WEBSOCKET_PROVIDER_URL='ws://127.0.0.1:8545/'
ERC_721_ADDRESS='$ERC721'
ERC_721_OWNER_KEY='$ERC721_OWNER'
TEST_ACCOUNT_KEY='$TEST'
" > ".forked.env"

cast rpc evm_setIntervalMining 15 > /dev/null