export interface MatchOperationMetadata {
  timestamp: number;
  validMatches: number;
  matchLimit: number;
  matchIds: string[];
  side: 'proposer' | 'recipient';
}
