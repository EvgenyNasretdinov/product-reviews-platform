import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

const STAR_INDEXES = [0, 1, 2, 3, 4] as const;

const SIZE_CLASSES = {
  sm: 'text-sm gap-0.5',
  md: 'text-base gap-1',
  lg: 'text-xl gap-1',
} as const;

export type RatingStarsSize = keyof typeof SIZE_CLASSES;

export interface RatingStarsProps {
  /** Average rating, expected in 0-5 but clamped defensively either way. */
  value: number;
  /**
   * Review count backing `value`. A product with no reviews always carries
   * `count: 0` (the API synthesises a zero summary, never a missing one —
   * see products.service.ts), which is what lets this component treat
   * "zero reviews" as unrated rather than as a one-star rating. `undefined`
   * is accepted for a caller that only has a bare rating, in which case the
   * label omits the review count clause entirely instead of guessing.
   */
  count?: number;
  size?: RatingStarsSize;
  className?: string;
  /**
   * Opt-in `data-testid`, left unset by every caller except `ReviewItem`
   * (`review-rating`) — the one place an e2e spec needs to find *each
   * review's own* stars specifically, as opposed to the header's or
   * `RatingSummary`'s, which render the exact same markup shape and would
   * otherwise be indistinguishable from it by role/label alone.
   */
  testId?: string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Drops a trailing ".00"/".50" → "5"/"3.5" so the label reads naturally. */
function formatValue(value: number): string {
  return Number(value.toFixed(2)).toString();
}

function describeRating(clampedValue: number, count: number | undefined): string {
  if (count === 0) {
    return 'No reviews yet';
  }
  if (count === undefined) {
    return `${formatValue(clampedValue)} out of 5 stars`;
  }
  const reviewsPhrase = count === 1 ? '1 review' : `${count} reviews`;
  return `${formatValue(clampedValue)} out of 5 stars, ${reviewsPhrase}`;
}

/** One star glyph, filled left-to-right by `fillPercent` (0-100). */
function Star({ fillPercent }: { fillPercent: number }): ReactNode {
  return (
    <span className="relative inline-block leading-none">
      <span className="text-border">★</span>
      <span
        className="absolute inset-0 overflow-hidden whitespace-nowrap text-amber-500"
        style={{ width: `${fillPercent}%` }}
      >
        ★
      </span>
    </span>
  );
}

/**
 * Renders five stars with a partial fill for the average rating, plus an
 * accessible text label carrying the same information — see the tests for
 * why the label, not the glyphs, is the actual content: a row of stars
 * with no text is silence to a screen reader, and rendering "no reviews"
 * as zero filled stars reads as a one-star product to everyone else.
 */
export function RatingStars({ value, count, size = 'md', className, testId }: RatingStarsProps): ReactNode {
  const clampedValue = clamp(value, 0, 5);
  const isUnrated = count === 0;
  const label = describeRating(clampedValue, count);

  return (
    <span
      role="img"
      aria-label={label}
      data-testid={testId}
      className={cn('inline-flex items-center', SIZE_CLASSES[size], className)}
    >
      {STAR_INDEXES.map((index) => (
        <Star key={index} fillPercent={isUnrated ? 0 : clamp((clampedValue - index) * 100, 0, 100)} />
      ))}
    </span>
  );
}
