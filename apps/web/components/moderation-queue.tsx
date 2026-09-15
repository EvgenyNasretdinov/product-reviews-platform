'use client';

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import type { ModerationDecisionInput, ModerationReviewDto } from '@reviews/contracts';
import { EmptyState } from '@/components/empty-state';
import { ModerationDecisionDialog } from '@/components/moderation-decision-dialog';
import { RatingStars } from '@/components/rating-stars';
import { Button } from '@/components/ui/button';

export interface ModerationQueueProps {
  /** Every review currently awaiting this queue's decision — full body, `moderationReason`, and the product it's about, unlike the public list's `ReviewDto`. See this file's own doc comment for why that means `ReviewItem` isn't reused here. */
  reviews: ModerationReviewDto[];
  /**
   * Records the decision. Takes the same two fields
   * `moderationDecisionInputSchema` requires — `decision` and a nullable
   * `reason` — as separate arguments rather than an object purely so a
   * call reads as "decide this review, this way, for this reason" at the
   * call site. Approving always passes `reason: null` (an approval
   * carries none); rejecting always passes a non-empty trimmed string,
   * enforced below before this is ever called — never both `null` for a
   * rejection, which is exactly what the API's own 400 guards against.
   */
  onDecide: (reviewId: string, decision: ModerationDecisionInput['decision'], reason: string | null) => Promise<unknown>;
  emptyTitle?: string;
  emptyDescription?: string;
  /** Whether an older page of this same queue exists beyond what `reviews` currently holds. Omitted entirely (rather than `false`) by a caller with nothing left to page through — see `ReviewList`'s identical convention. */
  hasMore?: boolean;
  onLoadMore?: () => void;
  isLoadingMore?: boolean;
}

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'long' }).format(date);
}

function withoutKey(record: Record<string, string>, key: string): Record<string, string> {
  const next = { ...record };
  delete next[key];
  return next;
}

/**
 * The moderator's queue: one row per review awaiting a decision, each
 * showing everything a human needs to judge it — the full body (never an
 * excerpt), which product and author it's for, its star rating, and, when
 * the automatic classifier is the reason it's here, the reason it flagged
 * it. Deliberately *not* `ReviewItem` (the public list's row) reused with
 * extra props: `ReviewItem`'s prop type is `Omit<ReviewDto,
 * 'moderationReason'>` specifically so that component can never render a
 * moderator's private note about a review to a public visitor (see its
 * own doc comment) — reusing it here, even by adding a prop, would mean
 * either widening that type back out (reopening the exact leak it exists
 * to prevent) or forking its render logic anyway. A moderator's row is
 * a different thing, showing different data, to a different reader; this
 * component is that thing, built from `ModerationReviewDto`
 * (`@reviews/contracts`) — `ReviewDto` plus `product`, both of them shared
 * contract types, not anything invented for this component alone.
 *
 * The product is shown by name, linked to its own page — a moderator
 * deciding whether a borderline review should be published needs to know
 * it's about a desk lamp, not a coffee machine, since tone, vocabulary,
 * and plausibility all read differently against the product it's for. A
 * bare `productId` couldn't offer that (see this project's git history:
 * an earlier version of this component showed the id, before
 * `ModerationReviewDto` added `product`). This queue is the one place a
 * review carries that context at all — `ReviewItem`'s `PublicReview` and
 * the plain `ReviewDto` a moderator's own decision response comes back as
 * both still have only `productId`, because the public list is already
 * read from the product's own page and doesn't need it repeated.
 *
 * Approving is a single action — a moderator does not need to explain why
 * something was fine. Rejecting opens `ModerationDecisionDialog`, a real
 * `Dialog` with a focus trap, rather than approving-with-no-reason's
 * mirror image: the reason is what the review's own author sees in place
 * of their review (`StatusBadge`), so it is required, never optional.
 *
 * A decided review leaves this list the moment its decision succeeds —
 * tracked as local `removedIds`, the same "own the optimistic state"
 * pattern `VoteButtons` uses and for the same reason: this component's
 * tests render it with a bare `onDecide` mock and no query cache to
 * refetch from, so "does the row disappear" has to be provable from this
 * component's own state, not from a cache invalidation happening
 * somewhere else. A failed decision does the opposite — the row stays,
 * with an inline message — so a moderator never loses track of an item
 * that didn't actually get decided.
 */
export function ModerationQueue({
  reviews,
  onDecide,
  emptyTitle = 'Nothing to review',
  emptyDescription = "You're all caught up — no reviews are waiting on a decision.",
  hasMore = false,
  onLoadMore,
  isLoadingMore = false,
}: ModerationQueueProps): ReactNode {
  const [removedIds, setRemovedIds] = useState<ReadonlySet<string>>(new Set());
  const [pendingApprovalId, setPendingApprovalId] = useState<string | null>(null);
  const [approveErrors, setApproveErrors] = useState<Record<string, string>>({});
  const [rejectTarget, setRejectTarget] = useState<ModerationReviewDto | null>(null);

  const visibleReviews = reviews.filter((review) => !removedIds.has(review.id));

  function markDecided(reviewId: string): void {
    setRemovedIds((current) => {
      const next = new Set(current);
      next.add(reviewId);
      return next;
    });
  }

  async function handleApprove(review: ModerationReviewDto): Promise<void> {
    setApproveErrors((current) => withoutKey(current, review.id));
    setPendingApprovalId(review.id);
    try {
      await onDecide(review.id, 'APPROVED', null);
      markDecided(review.id);
    } catch (error) {
      setApproveErrors((current) => ({
        ...current,
        [review.id]: error instanceof Error ? error.message : "Couldn't approve this review. Please try again.",
      }));
    } finally {
      setPendingApprovalId(null);
    }
  }

  async function handleConfirmReject(reason: string): Promise<void> {
    if (!rejectTarget) {
      return;
    }
    await onDecide(rejectTarget.id, 'REJECTED', reason);
    markDecided(rejectTarget.id);
  }

  // `hasMore` still guards its own "Load more" control below even when
  // `visibleReviews` is currently empty: every review on *this* page may
  // have just been decided while an older page (this same status, an
  // earlier cursor) still has more waiting — that's "caught up for now",
  // not "nothing left to review", and the moderator should still be able
  // to reach it rather than be told the queue is empty.
  if (visibleReviews.length === 0 && !hasMore) {
    return <EmptyState title={emptyTitle} description={emptyDescription} />;
  }

  return (
    <>
      {visibleReviews.length === 0 ? <EmptyState title={emptyTitle} description={emptyDescription} /> : null}

      <ul className="flex flex-col gap-4">
        {visibleReviews.map((review) => (
          <li key={review.id} className="flex flex-col gap-3 rounded-lg border border-border p-4">
            <div className="flex flex-wrap items-center gap-2">
              <RatingStars value={review.rating} size="sm" />
              <h3 className="text-sm font-semibold">{review.title}</h3>
            </div>

            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">{review.author.displayName}</span>
              <span aria-hidden="true">·</span>
              <time dateTime={review.createdAt.toISOString()}>{formatDate(review.createdAt)}</time>
              <span aria-hidden="true">·</span>
              {/* Linked to the product's own page — the one thing a bare
                  id could never give a moderator: seeing this review in
                  context, next to every other review this same product
                  already has, in one click. */}
              <Link
                href={`/products/${review.product.slug}`}
                className="font-medium text-foreground underline-offset-4 hover:underline"
              >
                {review.product.name}
              </Link>
            </div>

            <p className="text-sm text-foreground/90">{review.body}</p>

            {review.moderationReason ? (
              <p className="rounded-md border border-amber-600/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">
                <span className="font-medium">Flagged automatically:</span> {review.moderationReason}
              </p>
            ) : null}

            {approveErrors[review.id] ? (
              <p role="alert" className="text-sm text-destructive">
                {approveErrors[review.id]}
              </p>
            ) : null}

            <div className="flex gap-2">
              <Button
                type="button"
                onClick={() => void handleApprove(review)}
                disabled={pendingApprovalId === review.id}
              >
                {pendingApprovalId === review.id ? 'Approving…' : 'Approve'}
              </Button>
              <Button type="button" variant="destructive" onClick={() => setRejectTarget(review)}>
                Reject
              </Button>
            </div>
          </li>
        ))}
      </ul>

      {hasMore ? (
        <div className="flex justify-center">
          <Button type="button" variant="outline" onClick={onLoadMore} disabled={isLoadingMore}>
            {isLoadingMore ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      ) : null}

      <ModerationDecisionDialog
        open={rejectTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setRejectTarget(null);
          }
        }}
        reviewTitle={rejectTarget?.title ?? ''}
        onConfirm={handleConfirmReject}
      />
    </>
  );
}
