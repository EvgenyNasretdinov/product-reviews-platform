'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { reviewDtoSchema, type CreateReviewInput, type ReviewDto } from '@reviews/contracts';
import { ApiError, RateLimitedError, ReviewConflictError } from '@/lib/errors';
import { myReviewQueryKey } from '@/hooks/use-my-review';

/**
 * Posts through `/api/products/:productId/reviews` — a Next.js Route
 * Handler (app/api/products/[productId]/reviews/route.ts), not the API
 * directly. This runs in the browser, and the bearer token lives only in
 * the `session` cookie, which is `httpOnly` on purpose (see lib/session.ts)
 * — invisible to this code by design, the same reason
 * app/api/session/route.ts proxies login instead of the login form
 * calling the API straight from the browser.
 *
 * Uses a raw `fetch`, not `apiFetch`: `apiFetch`'s `ApiError` collapses
 * every error body down to `{ message, code }`, which would silently drop
 * the 429's numeric `Retry-After` header — this function reads it
 * straight off the `Response` and turns it into `RateLimitedError` below
 * specifically so a caller doesn't lose it.
 *
 * Exported (not just used internally) so its status-code branches — the
 * part of this file most likely to hide a bug — can be exercised
 * directly in tests, against a mocked `fetch`, without going through
 * `useSubmitReview`'s React Query plumbing. See use-submit-review.test.ts.
 */
export async function submitReview(productId: string, input: CreateReviewInput): Promise<ReviewDto> {
  const response = await fetch(`/api/products/${productId}/reviews`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });

  const text = await response.text();
  const body: unknown = text ? JSON.parse(text) : undefined;

  if (!response.ok) {
    const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const rawMessage = record.message;
    const message =
      typeof rawMessage === 'string'
        ? rawMessage
        : Array.isArray(rawMessage) && rawMessage.every((entry) => typeof entry === 'string')
          ? rawMessage.join('; ')
          : `Submitting the review failed (status ${response.status}).`;

    if (response.status === 409) {
      throw new ReviewConflictError('You have already reviewed this product.');
    }

    if (response.status === 429) {
      const retryAfterHeader = response.headers.get('Retry-After');
      const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : undefined;
      throw new RateLimitedError(
        Number.isFinite(retryAfterSeconds)
          ? `You're submitting reviews too quickly. Try again in ${retryAfterSeconds}s.`
          : "You're submitting reviews too quickly. Try again shortly.",
        Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : undefined,
      );
    }

    throw new ApiError(response.status, message);
  }

  const parsed = reviewDtoSchema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(502, 'The server returned an unexpected response for the submitted review.', undefined, {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

/**
 * The submission mutation `ReviewForm`'s caller wires into its `onSubmit`
 * prop. On success it invalidates `['reviews', productId]` (the public
 * list — see `useReviews` — which won't actually show the new review
 * until it's approved, but its count/summary can still change) and
 * `['me', 'reviews']` (see `useMyReview`, whose query key is
 * `['me', 'reviews', productId, ...]` — invalidating the shorter prefix
 * matches every product's "my review" query, not just this one, since
 * TanStack Query treats `queryKey` as a prefix match by default).
 *
 * On a 409 specifically, `['me', 'reviews']` is invalidated too, even
 * though the mutation itself failed: a 409 means the caller already has a
 * review for this product that the "does the user already have a review"
 * check above this form missed (a race with another tab, most likely).
 * Refetching immediately is what lets the page swap from the form to the
 * "Your review" panel on its own, which points the author at their
 * existing review far more directly than a plain error message could.
 */
export function useSubmitReview(productId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateReviewInput) => submitReview(productId, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['reviews', productId] });
      void queryClient.invalidateQueries({ queryKey: ['me', 'reviews'] });
    },
    onError: (error) => {
      if (error instanceof ReviewConflictError) {
        void queryClient.invalidateQueries({ queryKey: myReviewQueryKey(productId) });
      }
    },
  });
}
