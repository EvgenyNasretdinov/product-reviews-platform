'use client';

import { useCallback, type ReactNode } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { reviewSortSchema, type ReviewSort } from '@reviews/contracts';
import { EmptyState } from '@/components/empty-state';
import { RatingSummary, type RatingSummaryData } from '@/components/rating-summary';
import { ReviewItem } from '@/components/review-item';
import { ReviewSortSelect } from '@/components/review-sort-select';
import { Button } from '@/components/ui/button';
import { useReviews } from '@/hooks/use-reviews';
import { ApiError } from '@/lib/errors';

interface ReviewListProps {
  productId: string;
  summary: RatingSummaryData;
  /** The signed-in caller's id, or `null` when signed out — threaded straight through to `ReviewItem`, which needs it to derive `VoteButtons`' `canVote`/`isSignedIn`. */
  currentUserId: string | null;
}

const DEFAULT_SORT: ReviewSort = 'helpful';

function parseSort(raw: string | null): ReviewSort {
  const parsed = reviewSortSchema.safeParse(raw ?? undefined);
  return parsed.success ? parsed.data : DEFAULT_SORT;
}

function parseRatingFilter(raw: string | null): number | null {
  if (raw === null) {
    return null;
  }
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 && value <= 5 ? value : null;
}

function ReviewSkeleton(): ReactNode {
  return (
    <div className="flex flex-col gap-2 border-b border-border py-6 last:border-b-0" aria-hidden="true">
      <div className="h-4 w-24 animate-pulse rounded bg-muted" />
      <div className="h-3 w-40 animate-pulse rounded bg-muted" />
      <div className="h-3 w-full animate-pulse rounded bg-muted" />
      <div className="h-3 w-2/3 animate-pulse rounded bg-muted" />
    </div>
  );
}

function Spinner(): ReactNode {
  return (
    <span
      aria-hidden="true"
      className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
    />
  );
}

/**
 * The reviews section: rating histogram, sort control, and the paginated
 * list itself. A Client Component so selecting a sort or a rating filter
 * updates in place — re-fetching and re-rendering only this subtree —
 * rather than the whole product page (the header above it is a Server
 * Component and never re-renders for this).
 *
 * Sort and the rating filter live in the URL (`?sort=&rating=`), read
 * with `useSearchParams` and written with `router.replace(..., { scroll:
 * false })`, so a filtered view is shareable and the back button steps
 * through it without the page jumping to the top on every change.
 */
export function ReviewList({ productId, summary, currentUserId }: ReviewListProps): ReactNode {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const sort = parseSort(searchParams.get('sort'));
  const rating = parseRatingFilter(searchParams.get('rating'));

  const updateParams = useCallback(
    (next: { sort?: ReviewSort; rating?: number | null }) => {
      const params = new URLSearchParams(searchParams.toString());

      if (next.sort !== undefined) {
        if (next.sort === DEFAULT_SORT) {
          params.delete('sort');
        } else {
          params.set('sort', next.sort);
        }
      }

      if (next.rating !== undefined) {
        if (next.rating === null) {
          params.delete('rating');
        } else {
          params.set('rating', String(next.rating));
        }
      }

      const query = params.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  const { data, isPending, isError, error, fetchNextPage, hasNextPage, isFetchingNextPage, refetch } = useReviews(
    productId,
    { sort, rating },
  );

  const items = data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <section className="flex flex-col gap-8">
      <RatingSummary
        summary={summary}
        activeFilter={rating}
        onFilter={(nextRating) => updateParams({ rating: nextRating })}
      />

      {summary.reviewCount > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-4">
          <h2 className="text-lg font-semibold">Reviews</h2>
          <ReviewSortSelect value={sort} onChange={(nextSort) => updateParams({ sort: nextSort })} />
        </div>
      ) : null}

      {isPending ? (
        <ul>
          <ReviewSkeleton />
          <ReviewSkeleton />
          <ReviewSkeleton />
        </ul>
      ) : isError ? (
        <EmptyState
          title="Couldn't load reviews"
          description={error instanceof ApiError ? error.message : 'Something went wrong. Please try again.'}
          action={
            <Button type="button" variant="outline" onClick={() => void refetch()}>
              Try again
            </Button>
          }
        />
      ) : items.length === 0 ? (
        rating !== null ? (
          // Distinguished from the "no reviews yet" case below: the
          // product does have reviews, just none at this star rating —
          // the fix is to widen the filter, not to write the first review.
          <EmptyState
            title={`No ${rating}-star reviews`}
            description="No reviews match this filter. Clear it to see every review."
            action={
              <Button type="button" variant="outline" onClick={() => updateParams({ rating: null })}>
                Clear filter
              </Button>
            }
          />
        ) : (
          <EmptyState title="No reviews yet" description="Be the first to share what you think of this product." />
        )
      ) : (
        <>
          <ul>
            {items.map((review) => (
              <ReviewItem key={review.id} review={review} currentUserId={currentUserId} />
            ))}
          </ul>
          {hasNextPage ? (
            <div className="flex justify-center">
              <Button type="button" variant="outline" onClick={() => void fetchNextPage()} disabled={isFetchingNextPage}>
                {isFetchingNextPage ? <Spinner /> : null}
                {isFetchingNextPage ? 'Loading…' : 'Load more'}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
