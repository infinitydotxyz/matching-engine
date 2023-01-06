// import { Redis } from 'ioredis';

// import { OrderMatch } from './match/order-match';
// import { Match } from './match/types';

// export interface BlockOrderExecutionOptions {
//   blockNumber: number;
//   targetGasPriceGwei: number;
// }

// export class OrderExecutionBlock {
//   protected _matches: OrderMatch[];

//   constructor(rawMatches: Match[], protected _options: BlockOrderExecutionOptions, protected db: Redis) {
//     this._matches = rawMatches.map((item) => new OrderMatch(item));
//   }

//   async execute(): Promise<void> {

//   }
// }
