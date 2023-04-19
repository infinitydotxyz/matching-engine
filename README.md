

## Deploying
* Note: the deploy steps listed below are optimized for zero downtime 

1. Deploy a redis instance
    * For mainnet run `npm run deploy:prod:mainnet:redis -- version=<version number>` 
        * The version number is a unique identifier to be able to deploy multiple redis instances for the same env - it can be any number as long as that number isn't already in use 
    * The script will repeatedly log `Deploying...` until the redis instance is ready - once ready it will log the ip and read only ip of the redis instance - update your .env files with these ips before moving on to the next step

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