# Execution Engine

- Responsible for taking orders that may contain valid matches, attempting to find a best match for the order, and executing that match

- Execution Process

  - Client triggers an order that may have matches to be processed
  - Execution engine takes the order, iterates over the matches to find a valid match

    - Loads orders from firestore
    - Checks if valid
    - Checks gas costs

  - Maintain a pool of orders attempting to be executed

  - Build non-conflicting
