
## Setup 
* Install docker
    * Check if it is installed by running `docker -v`
* Start the container with `docker-compose up`


## Overview
* Clients are able to enqueue orders for matching     
    * When an order is enqueued it gets added to the ingesting queue
    * The ingesting queue transforms orders to the standard required for matching, and emits the enqueued event
    * The matching queue then takes the standardized orders
        * It will either 
            1. Find a best match
                * Save for execution
                * Emit an event for each order
            2. Not find any matches
                * Emit an event for the order that matching is complete but no matches were found

* Transaction builder will take 