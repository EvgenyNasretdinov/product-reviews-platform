import type { ReactNode } from 'react';
import type { ReviewStatus } from '@reviews/contracts';

export interface StatusBadgeProps {
  status: ReviewStatus;
  /**
   * Only meaningful for `REJECTED`. Typed as nullable rather than
   * optional to match `ReviewDto['moderationReason']` exactly — callers
   * pass a `ReviewDto` field straight through without reshaping it.
   */
  moderationReason: string | null;
}

/**
 * Renders the moderation state of the *author's own* review. This
 * component — not `ReviewItem`, the public list's row — is the only place
 * in the app allowed to render `moderationReason`: `toPublicReviewDto`
 * (apps/api's reviews.service.ts) nulls that field for every review
 * `ReviewItem` ever receives, so `ReviewItem` has no prop for it and never
 * could. Keeping this a separate component, rather than a `showReason`
 * flag on `ReviewItem`, is what makes it structurally impossible for a
 * future change to accidentally wire a moderator's private note about a
 * rejected review into the public list.
 *
 * `APPROVED` renders nothing: a published review is already visible in
 * the public list and needs no badge to explain its own state. `PENDING`
 * and `FLAGGED` both render the same neutral "Awaiting moderation" copy —
 * the difference between them (whether a human moderator, rather than the
 * automatic classifier, needs to look at it) isn't something the author
 * does anything differently for for, so surfacing it as a distinct status
 * would only be confusing. `REJECTED` is the one status where the author
 * needs an actual explanation, not just an acknowledgement.
 */
export function StatusBadge({ status, moderationReason }: StatusBadgeProps): ReactNode {
  if (status === 'APPROVED') {
    return null;
  }

  if (status === 'REJECTED') {
    return (
      <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
        <span className="font-medium">Not published.</span>{' '}
        {moderationReason ?? 'This review did not pass moderation.'}
      </p>
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-secondary px-3 py-1 text-xs font-medium text-secondary-foreground">
      <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground" aria-hidden="true" />
      Awaiting moderation
    </span>
  );
}
