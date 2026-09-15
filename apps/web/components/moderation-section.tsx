'use client';

import type { ReactNode } from 'react';
import type { ReviewStatus } from '@reviews/contracts';
import { EmptyState } from '@/components/empty-state';
import { ModerationQueue } from '@/components/moderation-queue';
import { Button } from '@/components/ui/button';
import { useModerationDecision, useModerationQueue } from '@/hooks/use-moderation';
import { ApiError } from '@/lib/errors';

interface ModerationSectionProps {
  status: ReviewStatus;
  title: string;
  emptyTitle: string;
  emptyDescription: string;
}

/**
 * The composing layer between `useModerationQueue`/`useModerationDecision`
 * and the presentational `ModerationQueue` — the same split
 * `WriteReviewSection` makes between its hooks and `ReviewForm`/`YourReview`,
 * and for the same reason: `ModerationQueue`'s own tests render it with a
 * bare `onDecide` mock and no `QueryClientProvider` at all (see its doc
 * comment), so the actual TanStack Query wiring has to live somewhere
 * else. This component is that somewhere else, and is itself deliberately
 * left untested at the unit level — same as `ReviewList`, the equivalent
 * "smart list" on the product page — since there is nothing left in it to
 * verify beyond "does it pass the right props through", which the
 * end-to-end run against the live servers covers instead.
 *
 * One `ModerationSection` per status: `app/moderation/page.tsx` renders
 * one for `FLAGGED` and one for `PENDING`, each with its own cursor
 * (`ModerationController#listQueue`'s cursor is scoped to the `status`
 * that produced it) and its own empty-state copy, rather than one queue
 * trying to merge two independently-paginated lists into a single feed.
 */
export function ModerationSection({ status, title, emptyTitle, emptyDescription }: ModerationSectionProps): ReactNode {
  const queue = useModerationQueue(status);
  const decision = useModerationDecision();

  const reviews = queue.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-lg font-semibold">{title}</h2>

      {queue.isPending ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : queue.isError ? (
        <EmptyState
          title="Couldn't load this queue"
          description={
            queue.error instanceof ApiError ? queue.error.message : 'Something went wrong. Please try again.'
          }
          action={
            <Button type="button" variant="outline" onClick={() => void queue.refetch()}>
              Try again
            </Button>
          }
        />
      ) : (
        <ModerationQueue
          reviews={reviews}
          onDecide={(reviewId, decisionValue, reason) =>
            decision.mutateAsync({ reviewId, decision: decisionValue, reason })
          }
          emptyTitle={emptyTitle}
          emptyDescription={emptyDescription}
          hasMore={queue.hasNextPage}
          onLoadMore={() => void queue.fetchNextPage()}
          isLoadingMore={queue.isFetchingNextPage}
        />
      )}
    </section>
  );
}
