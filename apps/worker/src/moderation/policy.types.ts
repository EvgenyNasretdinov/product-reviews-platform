export interface ModerationInput {
  title: string;
  body: string;
  rating: number;
  verifiedPurchase: boolean;
  authorPreviousBodies: string[];
}

export type Verdict =
  | { decision: 'APPROVED'; reason: null }
  | { decision: 'REJECTED'; reason: string }
  | { decision: 'FLAGGED'; reason: string };

export interface ModerationPolicy {
  classify(input: ModerationInput): Verdict;
}
