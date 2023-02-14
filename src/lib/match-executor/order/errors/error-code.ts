export enum ErrorCode {
  OrderSource = 1,
  OrderKind = 2,
  OrderSide = 3,
  DynamicOrder = 4,
  OrderCurrency = 5,
  OrderPrivate = 6,
  OrderTokenStandard = 7,
  DuplicateToken = 8,
  OrderTokenQuantity = 9,
  GasUsage = 10,
  NotSigned = 11,
  Signer = 12,
  NumCollections = 13,

  InfinityComplication = 50,
  FlowComplication = 51,

  SeaportOrderType = 100,
  SeaportConduitKey = 101,
  SeaportZone = 102,

  NotFound = 999,
  Unexpected = 1000
}
