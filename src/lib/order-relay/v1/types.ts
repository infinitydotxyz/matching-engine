import { ChainOBOrder, OrderSource } from '@infinityxyz/lib/types/core';

export interface OrderStatusEventSyncCursor {
  timestamp: number;
  orderId: string;
  eventId: string;
}

export interface OrderbookSnapshotOrder {
  id: string;
  order: ChainOBOrder;
  source: OrderSource;
  sourceOrder: unknown;
  gasUsage: string;
}
