import { OrderData } from '@/lib/orderbook/v1/types';

export interface Match {
  matchId: string;
  maxGasPriceGwei: number;
  arbitrageWei: string;
  isNative: boolean;
  offer: OrderData;
  listing: OrderData;
}
