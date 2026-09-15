import type { ReactNode } from 'react';
import type { ReviewDto } from '@reviews/contracts';
import { RatingStars } from '@/components/rating-stars';
import { StatusBadge } from '@/components/status-badge';

interface YourReviewProps {
  review: ReviewDto;
}

/**
 * The signed-in author's own copy of their review, rendered above the
 * public list. This exists because a submitted review does not appear in
 * that public list until a moderator (automatic or human) approves it —
 * without this panel the review would simply vanish from the author's
 * point of view the moment they hit submit, and the natural conclusion is
 * "the site ate my review," followed by a resubmit that hits a 409 and
 * looks even more broken.
 *
 * Deliberately not `ReviewItem` (the public list's row component) reused
 * with extra props: `review.moderationReason` is only non-null for the
 * caller's own reviews in the first place — the API nulls it on every
 * review `ReviewItem` ever receives (see `toPublicReviewDto`) — but
 * keeping this a wholly separate component is what makes it structurally
 * impossible for a future change to thread that field into the public
 * row by accident. `StatusBadge`, which actually renders
 * `moderationReason`, is used only from here.
 */
export function YourReview({ review }: YourReviewProps): ReactNode {
  const isAwaitingModeration = review.status === 'PENDING' || review.status === 'FLAGGED';

  return (
    <section
      aria-label="Your review"
      className="flex flex-col gap-3 rounded-lg border border-border bg-secondary/40 p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Your review</h2>
        <StatusBadge status={review.status} moderationReason={review.moderationReason} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <RatingStars value={review.rating} size="sm" />
        <h3 className="text-sm font-semibold">{review.title}</h3>
      </div>

      <p className="text-sm text-foreground/90">{review.body}</p>

      {isAwaitingModeration ? (
        <p className="text-xs text-muted-foreground">
          Reviews are checked before publication, usually within moments. This won&rsquo;t appear in the list below
          until it&rsquo;s approved.
        </p>
      ) : null}
    </section>
  );
}
