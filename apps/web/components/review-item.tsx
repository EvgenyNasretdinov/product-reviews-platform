import type { ReactNode } from 'react';
import type { ReviewDto } from '@reviews/contracts';
import { RatingStars } from '@/components/rating-stars';

interface ReviewItemProps {
  review: ReviewDto;
}

const dateFormatter = new Intl.DateTimeFormat('en-US', { dateStyle: 'long' });

function formatDate(date: Date): string {
  return dateFormatter.format(date);
}

/**
 * The helpfulness counts render as plain read-only numbers here rather
 * than as an interactive control: the vote button and its optimistic
 * update belong to `VoteButtons`/`useVote`, a separate component this
 * task does not build. Once added, it slots in next to these counts
 * without this component's own layout changing.
 */
export function ReviewItem({ review }: ReviewItemProps): ReactNode {
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

      {review.helpfulCount + review.notHelpfulCount > 0 ? (
        <p className="text-xs text-muted-foreground">
          {review.helpfulCount} of {review.helpfulCount + review.notHelpfulCount} found this helpful
        </p>
      ) : null}
    </li>
  );
}
