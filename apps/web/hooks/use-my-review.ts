'use client';

import { useQuery } from '@tanstack/react-query';
import { paginatedSchema, reviewDtoSchema, type ReviewDto } from '@reviews/contracts';
import { ApiError } from '@/lib/errors';

const myReviewsPageSchema = paginatedSchema(reviewDtoSchema);

export function myReviewQueryKey(productId: string): readonly unknown[] {
  return ['me', 'reviews', productId] as const;
}

/**
 * Goes through `/api/me/reviews`, a Route Handler
 * (app/api/me/reviews/route.ts), for the same reason `useSubmitReview`
 * proxies the POST: the bearer token lives only in the httpOnly `session`
 * cookie, which this browser code cannot read. The route accepts
 * `?productId=` and does the "does the caller have a review for this one
 * product" search server-side, since `GET /me/reviews` itself has no
 * `productId` filter — see that route's own doc comment for how it
 * narrows an unbounded, newest-first history down to one match.
 */
async function fetchMyReviewForProduct(productId: string): Promise<ReviewDto | null> {
  const response = await fetch(`/api/me/reviews?productId=${encodeURIComponent(productId)}`);

  if (response.status === 401) {
    // Signed out (or the session cookie expired mid-visit): nothing to
    // show, not an error — the caller decides whether to prompt sign-in.
    return null;
  }

  const body: unknown = await response.json().catch(() => undefined);

  if (!response.ok) {
    const message =
      body && typeof body === 'object' && typeof (body as Record<string, unknown>).message === 'string'
        ? ((body as Record<string, unknown>).message as string)
        : `Failed to load your review (status ${response.status}).`;
    throw new ApiError(response.status, message);
  }

  const parsed = myReviewsPageSchema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(502, 'The server returned an unexpected response for your reviews.', undefined, {
      cause: parsed.error,
    });
  }

  return parsed.data.items[0] ?? null;
}

/**
 * The signed-in caller's own review for one product, or `null` if they
 * haven't written one (or aren't signed in). `enabled` is threaded
 * through explicitly rather than inferred, so a caller that already knows
 * from server-rendered session state that nobody is signed in can skip
 * the request entirely instead of firing it and getting back `null`.
 *
 * Polls every 2s for as long as the review is `PENDING`/`FLAGGED` — the
 * one place in this app that makes the moderation worker's own progress
 * visible without a manual reload: submit a review, watch its badge
 * change from "Awaiting moderation" to gone (approved) or to a reason
 * (rejected) within about a second, live.
 */
export function useMyReview(productId: string, enabled: boolean) {
  return useQuery({
    queryKey: myReviewQueryKey(productId),
    queryFn: () => fetchMyReviewForProduct(productId),
    enabled,
    refetchInterval: (query) => {
      const review = query.state.data;
      return review && (review.status === 'PENDING' || review.status === 'FLAGGED') ? 2000 : false;
    },
  });
}
