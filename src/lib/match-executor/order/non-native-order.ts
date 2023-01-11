import { NonNativeMatchExecutionInfo } from '../match/types';
import { SourceOrder } from './source-order';

export abstract class NonNativeOrder<RawOrder> extends SourceOrder<RawOrder> {
  abstract getExecutionInfo(taker: string): Promise<Omit<NonNativeMatchExecutionInfo, 'nativeExecutionTransfers'>>;
}
