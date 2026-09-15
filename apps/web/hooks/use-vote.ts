'use client';

import { useMutation, useQueryClient, type InfiniteData, type QueryKey } from '@tanstack/react-query';
import type { ReviewDto, VoteValue } from '@reviews/contracts';
import { ApiError } from '@/lib/errors';

interface ReviewPage {
  items: ReviewDto[];
  nextCursor: string | null;
}

export interface CastVoteVariables {
  /** The vote to move to; `null` clears it. */
  value: VoteValue | null;
  /**
   * What the caller's own vote was immediately before this click. Comes
   * from `VoteButtons`' own `activeVote` state (see its doc comment on
   * `onVote`) — the server has no endpoint that reports a per-user vote
   * back, so nothing on this side of the mutation knows it independently.
   * Used only to compute the right delta for the cached counts below;
   * never sent in the request itself.
   */
  previousValue: VoteValue | null;
}

/**
 * PUTs (or, for a `null` value, DELETEs) through
 * `/api/reviews/:reviewId/vote` — a Next.js Route Handler
 * (app/api/reviews/[reviewId]/vote/route.ts), not the API directly, for
 * the same reason every other mutation in this app goes through one: the
 * bearer token lives only in the `session` cookie, which is `httpOnly`
 * and therefore invisible to this browser code by design (see
 * lib/session.ts).
 */
async function sendVote(reviewId: string, value: VoteValue | null): Promise<void> {
  const response = await fetch(`/api/reviews/${reviewId}/vote`, {
    method: value ? 'PUT' : 'DELETE',
    headers: value ? { 'Content-Type': 'application/json' } : undefined,
    body: value ? JSON.stringify({ value }) : undefined,
  });

  if (response.ok) {
    return;
  }

  const body: unknown = await response.json().catch(() => undefined);
  const message =
    body && typeof body === 'object' && typeof (body as Record<string, unknown>).message === 'string'
      ? ((body as Record<string, unknown>).message as string)
      : `Voting failed (status ${response.status}).`;
  throw new ApiError(response.status, message);
}

/** Moves `review`'s counts from `previousValue` to `nextValue`, one vote at a time — mirrors `VoteButtons`' own `moveVote`, applied here to the cached page instead of local component state. */
function withMovedVote(review: ReviewDto, previousValue: VoteValue | null, nextValue: VoteValue | null): ReviewDto {
  let { helpfulCount, notHelpfulCount } = review;
  if (previousValue === 'HELPFUL') helpfulCount -= 1;
  if (previousValue === 'NOT_HELPFUL') notHelpfulCount -= 1;
  if (nextValue === 'HELPFUL') helpfulCount += 1;
  if (nextValue === 'NOT_HELPFUL') notHelpfulCount += 1;
  return { ...review, helpfulCount, notHelpfulCount };
}

function patchCachedReview(
  data: InfiniteData<ReviewPage> | undefined,
  reviewId: string,
  previousValue: VoteValue | null,
  nextValue: VoteValue | null,
): InfiniteData<ReviewPage> | undefined {
  if (!data) {
    return data;
  }
  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      items: page.items.map((review) =>
        review.id === reviewId ? withMovedVote(review, previousValue, nextValue) : review,
      ),
    })),
  };
}

type ReviewsSnapshot = Array<[QueryKey, InfiniteData<ReviewPage> | undefined]>;

/**
 * `useVote(reviewId, productId)` — the mutation `ReviewItem` wires into
 * `VoteButtons`' `onVote` prop. Its cache-side optimism is layered on top
 * of, not a replacement for, `VoteButtons`' own local optimistic counts:
 * this hook exists so every *other* consumer of the same review data
 * (every cached page under `['reviews', productId, sort, rating]` for
 * every sort and rating filter the caller has ever selected, not just the
 * one currently on screen) reflects the vote immediately too, and so a
 * refetch after this settles converges on the server's own truth rather
 * than trusting either side's guess forever.
 *
 * Locating the right cached entries: `useReviews` keys every page as
 * `['reviews', productId, sort, rating]`, one cache entry per sort/rating
 * combination the caller has visited. This hook never targets one of
 * those exact keys — it uses `getQueriesData`/`setQueriesData` with the
 * shorter key `['reviews', productId]`, which TanStack Query matches as a
 * *prefix* against every cached query key by default, i.e. every
 * sort/rating variant at once. The updater then walks each matching
 * query's pages looking for the one review whose `id` matches — it may
 * appear on a different page number under a different sort, or not appear
 * at all under an active rating filter, and both are fine: the `.map`
 * below is a no-op for any page that doesn't contain it.
 */
export function useVote(reviewId: string, productId: string) {
  const queryClient = useQueryClient();
  const queryKey: QueryKey = ['reviews', productId];

  return useMutation<void, ApiError, CastVoteVariables, ReviewsSnapshot>({
    mutationFn: ({ value }) => sendVote(reviewId, value),

    onMutate: async ({ value, previousValue }) => {
      // Stops an in-flight fetch for this same product's reviews from
      // resolving after our optimistic patch below and clobbering it with
      // now-stale data.
      await queryClient.cancelQueries({ queryKey });

      const snapshot = queryClient.getQueriesData<InfiniteData<ReviewPage>>({ queryKey });

      queryClient.setQueriesData<InfiniteData<ReviewPage>>({ queryKey }, (data) =>
        patchCachedReview(data, reviewId, previousValue, value),
      );

      return snapshot;
    },

    onError: (_error, _variables, snapshot) => {
      // The rollback that matters: without this, a failed vote would
      // leave every cached list showing a count that never actually
      // landed on the server.
      snapshot?.forEach(([key, data]) => {
        queryClient.setQueryData(key, data);
      });
    },

    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey });
    },
  });
}
