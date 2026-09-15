'use client';

import { useInfiniteQuery, useMutation, useQueryClient, type InfiniteData, type QueryKey } from '@tanstack/react-query';
import {
  paginatedSchema,
  reviewDtoSchema,
  type ModerationDecisionInput,
  type ReviewDto,
  type ReviewStatus,
} from '@reviews/contracts';
import { ApiError } from '@/lib/errors';

const moderationQueueSchema = paginatedSchema(reviewDtoSchema);

interface ModerationQueuePage {
  items: ReviewDto[];
  nextCursor: string | null;
}

/** `['moderation', 'queue', status]` for one status's own cache entry, or the bare `['moderation', 'queue']` prefix that matches every status at once — see `useModerationDecision`'s invalidation below, the same prefix-match trick `useVote` uses for `['reviews', productId]`. */
export function moderationQueueKey(status: ReviewStatus): QueryKey {
  return ['moderation', 'queue', status];
}

async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  const body: unknown = await response.json().catch(() => undefined);
  if (body && typeof body === 'object') {
    const rawMessage = (body as Record<string, unknown>).message;
    if (typeof rawMessage === 'string') {
      return rawMessage;
    }
    if (Array.isArray(rawMessage) && rawMessage.every((entry) => typeof entry === 'string')) {
      return rawMessage.join('; ');
    }
  }
  return fallback;
}

/**
 * Goes through `/api/moderation/reviews`, a Route Handler
 * (app/api/moderation/reviews/route.ts), not the API directly — the same
 * reason every other client-side call in this app that needs the bearer
 * token does: the token lives only in the `session` cookie, which is
 * `httpOnly` and therefore invisible to this browser code by design (see
 * lib/session.ts).
 */
async function fetchModerationQueuePage(
  status: ReviewStatus,
  cursor: string | undefined,
): Promise<ModerationQueuePage> {
  const params = new URLSearchParams({ status });
  if (cursor) {
    params.set('cursor', cursor);
  }

  const response = await fetch(`/api/moderation/reviews?${params.toString()}`);
  const body: unknown = await response.json().catch(() => undefined);

  if (!response.ok) {
    throw new ApiError(
      response.status,
      await readErrorMessage(response, `Loading the moderation queue failed (status ${response.status}).`),
    );
  }

  const parsed = moderationQueueSchema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(502, 'The server returned an unexpected response for the moderation queue.', undefined, {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

/**
 * Pages one status's slice of the moderation queue, mirroring
 * `useReviews`'s shape (`useInfiniteQuery`, one cache entry per key). Each
 * status gets its own cache entry (`moderationQueueKey(status)`) rather
 * than one shared "the queue" entry — `ModerationController#listQueue`'s
 * own cursor is scoped to the `status` that produced it (see
 * `CURSOR_SCOPE` in moderation.service.ts) and would reject being reused
 * under a different one, the same reason `useReviews` keys on `sort` too.
 */
export function useModerationQueue(status: ReviewStatus) {
  return useInfiniteQuery<ModerationQueuePage, ApiError, InfiniteData<ModerationQueuePage>, QueryKey, string | undefined>({
    queryKey: moderationQueueKey(status),
    queryFn: ({ pageParam }) => fetchModerationQueuePage(status, pageParam),
    initialPageParam: undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
}

export interface DecideVariables {
  reviewId: string;
  decision: ModerationDecisionInput['decision'];
  reason: string | null;
}

/**
 * Posts through `/api/moderation/reviews/:id`, the same Route Handler
 * proxying reason `fetchModerationQueuePage` above does.
 */
async function sendDecision({ reviewId, decision, reason }: DecideVariables): Promise<ReviewDto> {
  const response = await fetch(`/api/moderation/reviews/${reviewId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision, reason }),
  });
  const body: unknown = await response.json().catch(() => undefined);

  if (!response.ok) {
    throw new ApiError(response.status, await readErrorMessage(response, `Recording the decision failed (status ${response.status}).`));
  }

  const parsed = reviewDtoSchema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(502, 'The server returned an unexpected response for the moderation decision.', undefined, {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

/**
 * The mutation `ModerationQueue`'s caller (see `ModerationSection`) wires
 * into its `onDecide` prop. `ModerationQueue` already owns the
 * user-visible "this row disappears now" optimism itself (its own
 * `removedIds` state — see that component's doc comment), so this hook's
 * job is narrower: make sure every *other* cached view of this same queue
 * (in particular a second browser tab, or this same status's next page
 * once it's fetched) also stops showing a review that has already been
 * decided. `onSettled` invalidates the bare `['moderation', 'queue']`
 * prefix — both statuses at once — rather than just the one the caller
 * passed in, because a decision always moves a review *out of* whichever
 * status it was in; there is never a matching status left to leave stale.
 */
export function useModerationDecision() {
  const queryClient = useQueryClient();

  return useMutation<ReviewDto, ApiError, DecideVariables>({
    mutationFn: sendDecision,
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['moderation', 'queue'] });
    },
  });
}
