

## Deploying
* Note: the deploy steps listed below are optimized for zero downtime

1. Deploy a redis instance
    * For mainnet run `npm run deploy:prod:mainnet:redis -- version=<version number>` 
        * The version number is a unique identifier to be able to deploy multiple redis instances for the same env - it can be any number as long as that number isn't already in use 
    * The script will repeatedly log `Deploying...` until the redis instance is ready - once ready it will log the ip and read only ip of the redis instance
    *  Update your .env files with these ips before moving on to the next step

2. Deploy the matching engine
    * Mainnet `npm run deploy:prod:mainnet:me`

3. Deploy the execution engine
    * Mainnet `npm run deploy:prod:mainnet:ee`

4. Start the matching engine
    * Mainnet `npm run start:prod:mainnet:me`
    * To start a specific version of the service pass the `version flag` (this is a GAE version not arbitrary like the redis version)
        * `npm run start:prod:mainnet:me -- version=20230419t125654`

5. Start the execution engine 
    * Mainnet `npm run start:prod:mainnet:ee` 
    * To start a specific version of the service pass the `version flag` (this is a GAE version not arbitrary like the redis version)
        * `npm run start:prod:mainnet:ee -- version=20230419t125812`

6. Once the matching engine is synced, update traffic 
    * Mainnet matching engine: `gcloud app services set-traffic matching-engine-mainnet --splits <GAE VERSION>=100 --project=nftc-infinity`
        * `gcloud app services set-traffic matching-engine-mainnet --splits 20230419t125654=100 --project=nftc-infinity`
    * Mainnet execution engine: `gcloud app services set-traffic execution-engine-mainnet --splits <GAE VERSION>=100 --project=nftc-infinity`
        * `gcloud app services set-traffic execution-engine-mainnet --splits 20230419t125812=100 --project=nftc-infinity`

7. Get previous GAE versions
    * Mainnet matching engine: `gcloud app versions list --service=matching-engine-mainnet --project=nftc-infinity`
    * Mainnet execution engine: `gcloud app versions list --service=execution-engine-mainnet --project=nftc-infinity`
    * Redis `gcloud redis instances list --region=us-east1 --project=nftc-infinity`

7. Delete the previous versions
    * Mainnet matching engine: `gcloud app versions delete <GAE VERSION> --service=matching-engine-mainnet --project=nftc-infinity`
    * Mainnet execution engine: `gcloud app versions delete <GAE VERSION> --service=execution-engine-mainnet --project=nftc-infinity`
    * Redis: delete from console `gcloud redis instances delete <INSTANCE NAME> --region=us-east1 --project=nftc-infinity`


## Env Variables
* Supports `.env.<ENV>.<CHAIN_NAME>.<LOCATION>`
    * ENV is based on the `INFINITY_NODE_ENV` env variable can be `prod` or `dev` 
    * CHAIN_NAME is set based on the `CHAIN_ID` env variable and currently supports `mainnet` or `goerli`
    * LOCATION is set based on the `IS_DEPLOYED` env variable and can be either `local` or `deploy`

```
# Enable or disable logging for queues
DEBUG="1" 

CHAIN_ID="1"

# Whether the application is deployed (used to select an env file - typically only set in app.yaml files)
IS_DEPLOYED="1"

# Whether the application is running in "dev" or "prod" mode (used to select an env file)
INFINITY_NODE_ENV=""

WEBSOCKET_PROVIDER_URL=""
HTTP_PROVIDER_URL=""

REDIS_URL="IP:PORT"
READ_REDIS_URL="IP:PORT"

# Api key for api endpoints
API_KEY=""

# Match executor address
MATCH_EXECUTOR_ADDRESS=""

# Flow exchange address
EXCHANGE_ADDRESS=""

# Private key of the flashbots auth signer (should not contain funds)
FLASHBOTS_AUTH_SIGNER_KEY=""

# Private key of the initiator
INITIATOR_KEY=""

# OpenSea api key for requesting signatures
OPENSEA_API_KEY=""

# Enable specific components disable with "" or "0" enable with "1"
EXECUTION_ENGINE=""
MATCHING_ENGINE=""
API_READONLY=""
```


## Supporting new marketplaces
* Update lib
* Update the reservoir sdk to the same version as the functions repo
* Update the `NonNativeOrderFactory` to return an order for the marketplace you want to add `src/lib/match-executor/order/non-native-order-factory.ts`
* Implement a `NonNativeOrder` for each order type you would like to support. Example `src/lib/match-executor/order/seaport`
* Update the config to include the marketplace and order types you added support for `src/lib/match-executor/order/config.ts`