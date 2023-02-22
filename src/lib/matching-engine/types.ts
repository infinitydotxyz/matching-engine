export interface MatchOperationMetadata {
  validMatches: number;
  matchLimit: number;
  matchIds: string[];
  side: 'proposer' | 'recipient';
  timing: {
    proposerInitiatedAt: number;
    matchedAt: number;
    matchDuration: number;
  };
}
