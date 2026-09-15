'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { reviewDtoSchema, type ReviewDto, type UpdateReviewInput } from '@reviews/contracts';
import { ApiError } from '@/lib/errors';
import { myReviewQueryKey } from '@/hooks/use-my-review';

function messageFrom(body: unknown, fallback: string): string {
  const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const raw = record.message;
  if (typeof raw === 'string') return raw;
  // Nest's ValidationPipe returns `message` as an array of strings.
  if (Array.isArray(raw) && raw.every((entry) => typeof entry === 'string')) return raw.join('; ');
  return fallback;
}

/**
 * Both of these go through `/api/reviews/:reviewId` (a Route Handler)
 * rather than the API directly, for the reason every mutation in this app
 * does: the bearer token is in an `httpOnly` cookie this code cannot read.
 *
 * Exported alongside the hooks so their status-code branches — the part
 * most likely to hide a bug — can be exercised against a mocked `fetch`
 * without React Query's plumbing, the same split `submitReview` uses.
 */
export async function updateReview(reviewId: string, input: UpdateReviewInput): Promise<ReviewDto> {
  const response = await fetch(`/api/reviews/${reviewId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });

  const text = await response.text();
  const body: unknown = text ? JSON.parse(text) : undefined;

  if (!response.ok) {
    // 403 is the API refusing an edit by someone who is not the author —
    // including a moderator, who may delete a review but never rewrite
    // one. Saying so plainly beats a generic failure, because the caller
    // is otherwise looking at a button that appears to do nothing.
    if (response.status === 403) {
      throw new ApiError(403, 'Only the review’s author can edit it.');
    }
    if (response.status === 404) {
      throw new ApiError(404, 'This review no longer exists.');
    }
    throw new ApiError(response.status, messageFrom(body, `Saving your review failed (status ${response.status}).`));
  }

  const parsed = reviewDtoSchema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(502, 'The server returned an unexpected response for the edited review.', undefined, {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

export async function deleteReview(reviewId: string): Promise<void> {
  const response = await fetch(`/api/reviews/${reviewId}`, { method: 'DELETE' });

  if (response.status === 204) {
    return;
  }

  // A 404 means it is already gone, which is exactly the state the caller
  // asked for. Treating it as success keeps a double-click, or a delete
  // racing another tab, from reporting a failure for an outcome that did
  // in fact happen.
  if (response.status === 404) {
    return;
  }

  const text = await response.text();
  const body: unknown = text ? JSON.parse(text) : undefined;
  throw new ApiError(response.status, messageFrom(body, `Deleting your review failed (status ${response.status}).`));
}

/**
 * Editing a review puts it back through moderation: the API resets it to
 * `PENDING`, and if it had been `APPROVED` it writes a
 * `review.unpublished` event before the resubmission so the rating stops
 * counting the old text before it starts counting the new. Both queries
 * below are therefore stale on success — the public list because the
 * review may have just left it, and the author's own copy because its
 * status changed underneath them.
 */
export function useUpdateReview(productId: string, reviewId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: UpdateReviewInput) => updateReview(reviewId, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['reviews', productId] });
      void queryClient.invalidateQueries({ queryKey: myReviewQueryKey(productId) });
    },
  });
}

/**
 * Deletion is a hard delete on the API — the row goes, its votes cascade,
 * and an event makes the rating recompute without it. There is no undo,
 * which is why the caller confirms first.
 *
 * The author's own "do I have a review here" query is set to `null`
 * directly rather than only invalidated, so the form returns immediately
 * instead of after a refetch. It is still invalidated as well: the
 * direct write is what makes the UI feel instant, and the refetch is
 * what makes it correct if the server disagrees.
 */
export function useDeleteReview(productId: string, reviewId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => deleteReview(reviewId),
    onSuccess: () => {
      queryClient.setQueryData(myReviewQueryKey(productId), null);
      void queryClient.invalidateQueries({ queryKey: ['reviews', productId] });
      void queryClient.invalidateQueries({ queryKey: myReviewQueryKey(productId) });
    },
  });
}
