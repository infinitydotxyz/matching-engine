# Matching Engine

- Responsible for taking an order and performing the matching logic to find any matches
- It is coupled to the orderbook storage such that the orderbook storage is optimized for the matching engine
- Matches should be stored for all orders in the match.
  - Currently this is done by storing the matches in the ordered set: `orderbook:${orderbook version}:chain:${configured chainId}:order-matches:${orderId}`
- If any matches are found, the matching engine should trigger the execution engine to perform the match
