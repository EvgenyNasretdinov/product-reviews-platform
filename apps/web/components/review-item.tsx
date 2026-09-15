'use client';

import type { ReactNode } from 'react';
import type { ReviewDto } from '@reviews/contracts';
import { RatingStars } from '@/components/rating-stars';
import { VoteButtons } from '@/components/vote-buttons';
import { useVote } from '@/hooks/use-vote';

/**
 * `ReviewDto` minus `moderationReason` — the type this component actually
 * accepts. The API already nulls that field before a public review ever
 * reaches the browser (see `toPublicReviewDto` in apps/api's
 * reviews.service.ts), but a null value flowing through at runtime isn't
 * what stops it from rendering here: nothing about a plain `ReviewDto`
 * prop would stop a future edit from adding `{review.moderationReason}`
 * to this component's JSX, and nothing in this component's own tests
 * would catch that. Typing the prop as `Omit<ReviewDto, 'moderationReason'>`
 * makes that edit fail to compile instead — the property simply isn't on
 * the type this component has. A `ReviewDto` is still assignable here
 * (structural typing: it has every field this narrower type asks for,
 * `moderationReason` is just extra baggage TypeScript doesn't mind
 * carrying past a non-literal call site), so `ReviewList` passing
 * `review: ReviewDto` straight through needs no change.
 */
export type PublicReview = Omit<ReviewDto, 'moderationReason'>;

interface ReviewItemProps {
  review: PublicReview;
  /** The signed-in caller's id, or `null` when signed out. Used only to derive `canVote`/`isSignedIn` for `VoteButtons` below — never to widen what this component reads off `review` itself. */
  currentUserId: string | null;
}

const dateFormatter = new Intl.DateTimeFormat('en-US', { dateStyle: 'long' });

function formatDate(date: Date): string {
  return dateFormatter.format(date);
}

/**
 * Renders one review, with `VoteButtons`/`useVote` wired in for its
 * helpfulness counts (previously a plain read-only number in this slot —
 * see this file's git history for the version that comment described).
 * `useVote` is called here rather than inside `VoteButtons` itself so that
 * component's own tests can render it with a bare mock `onVote` and no
 * `QueryClientProvider` at all — see vote-buttons.tsx's doc comment.
 *
 * `canVote` mirrors the server's own rule (`VotesController#vote`'s 403):
 * signed in and not this review's own author. It is computed here, from
 * `currentUserId`, rather than left for a 403 to communicate after the
 * fact — a control that looks available and then errors on click is worse
 * than one that explains itself up front.
 */
export function ReviewItem({ review, currentUserId }: ReviewItemProps): ReactNode {
  const vote = useVote(review.id, review.productId);
  const isSignedIn = currentUserId !== null;
  const canVote = isSignedIn && currentUserId !== review.author.id;

  return (
    <li className="flex flex-col gap-2 border-b border-border py-6 last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        <RatingStars value={review.rating} size="sm" />
        <h3 className="text-sm font-semibold">{review.title}</h3>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{review.author.displayName}</span>
        <span aria-hidden="true">·</span>
        <time dateTime={review.createdAt.toISOString()}>{formatDate(review.createdAt)}</time>
        {review.verifiedPurchase ? (
          <span className="rounded-full bg-secondary px-2 py-0.5 text-xs font-medium text-secondary-foreground">
            Verified purchase
          </span>
        ) : null}
      </div>

      <p className="text-sm text-foreground/90">{review.body}</p>

      <VoteButtons
        reviewId={review.id}
        helpfulCount={review.helpfulCount}
        notHelpfulCount={review.notHelpfulCount}
        canVote={canVote}
        isSignedIn={isSignedIn}
        onVote={(value, previousVote) => vote.mutateAsync({ value, previousValue: previousVote })}
      />
    </li>
  );
}
