import type { ReactNode } from 'react';
import { RatingStars } from '@/components/rating-stars';

const STAR_VALUES = [5, 4, 3, 2, 1] as const;

export interface RatingSummaryData {
  reviewCount: number;
  averageRating: number;
  distribution: Record<1 | 2 | 3 | 4 | 5, number>;
}

interface RatingSummaryProps {
  summary: RatingSummaryData;
  /** Called with the star value a row was activated for, or `null` to clear the filter. */
  onFilter: (rating: number | null) => void;
  activeFilter: number | null;
}

function starsLabel(star: number): string {
  return star === 1 ? '1 star' : `${star} stars`;
}

function reviewsLabel(count: number): string {
  return count === 1 ? '1 review' : `${count} reviews`;
}

/**
 * A row's percentage is `count / reviewCount`, which divides by zero the
 * moment a product has no reviews at all. Rather than guard that division
 * at every call site, `reviewCount === 0` short-circuits the whole
 * histogram: there is nothing to filter on an unrated product, so it
 * renders a plain "no reviews yet" message instead of five buttons that
 * would each read `NaN%`.
 */
export function RatingSummary({ summary, onFilter, activeFilter }: RatingSummaryProps): ReactNode {
  const { reviewCount, averageRating, distribution } = summary;

  return (
    <section
      aria-label="Rating summary"
      data-testid="rating-summary"
      className="flex flex-col gap-4 sm:flex-row sm:items-start sm:gap-8"
    >
      <div className="flex flex-col items-start gap-1">
        <span className="text-3xl font-semibold">{reviewCount === 0 ? '—' : averageRating.toFixed(2)}</span>
        <RatingStars value={averageRating} count={reviewCount} size="lg" />
        {/* The star row's rating/count is otherwise only readable from its
            aria-label — real information for a screen reader, but nothing
            a sighted visitor can actually see printed anywhere. This is
            the one place that count is rendered as plain visible text. */}
        {reviewCount > 0 ? <span className="text-sm text-muted-foreground">{reviewsLabel(reviewCount)}</span> : null}
      </div>

      {reviewCount === 0 ? (
        <p className="text-sm text-muted-foreground">No reviews yet.</p>
      ) : (
        <ul className="flex w-full max-w-sm flex-col gap-1">
          {STAR_VALUES.map((star) => {
            const count = distribution[star];
            const percent = Math.round((count / reviewCount) * 100);
            const isActive = activeFilter === star;

            return (
              <li key={star}>
                <button
                  type="button"
                  aria-pressed={isActive}
                  onClick={() => onFilter(isActive ? null : star)}
                  aria-label={`${starsLabel(star)}, ${reviewsLabel(count)}, ${percent}%`}
                  className="flex w-full items-center gap-2 rounded-md px-1 py-0.5 text-sm hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 aria-pressed:bg-secondary"
                >
                  <span className="w-10 shrink-0 text-muted-foreground" aria-hidden="true">
                    {star} ★
                  </span>
                  <span className="h-2 flex-1 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                    <span className="block h-full rounded-full bg-amber-500" style={{ width: `${percent}%` }} />
                  </span>
                  <span className="w-10 shrink-0 text-right text-muted-foreground" aria-hidden="true">
                    {percent}%
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
