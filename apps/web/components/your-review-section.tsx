'use client';

import { useState, type ReactNode } from 'react';
import type { ReviewDto } from '@reviews/contracts';
import { DeleteReviewDialog } from '@/components/delete-review-dialog';
import { ReviewForm } from '@/components/review-form';
import { YourReview } from '@/components/your-review';
import { useDeleteReview, useUpdateReview } from '@/hooks/use-manage-review';

interface YourReviewSectionProps {
  productId: string;
  review: ReviewDto;
}

/**
 * The author's own review, plus the two things they can do to it. This is
 * a component rather than more branches inside `WriteReviewSection`
 * because both mutations need the review's id: keeping them here means
 * `useUpdateReview`/`useDeleteReview` are only ever called where a review
 * is known to exist, instead of being handed a placeholder id on every
 * render of a page whose visitor has not written one.
 *
 * `YourReview` stays purely presentational and `ReviewForm` stays purely
 * a form — the same split `WriteReviewSection` draws between them. What
 * lives here is only the decision of which one the moment calls for, and
 * the confirmation step in front of the irreversible one.
 */
export function YourReviewSection({ productId, review }: YourReviewSectionProps): ReactNode {
  const [isEditing, setIsEditing] = useState(false);
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);

  const updateReview = useUpdateReview(productId, review.id);
  const deleteReview = useDeleteReview(productId, review.id);

  if (isEditing) {
    return (
      <section aria-label="Edit your review" className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Edit your review</h2>
        <ReviewForm
          productId={productId}
          // Remounts the form whenever the underlying review changes, so
          // an edit that lands while the form is open (from another tab,
          // or the moderation worker rewriting the status) does not leave
          // stale text in uncontrolled inputs that ignore a changed
          // `defaultValues`.
          key={`${review.id}:${review.rating}:${review.title}:${review.body}`}
          defaultValues={{ rating: review.rating, title: review.title, body: review.body }}
          submitLabel="Save changes"
          submittingLabel="Saving…"
          onCancel={() => setIsEditing(false)}
          hint="Editing sends the review back to be checked, so it leaves the public list until it is approved again."
          onSubmit={async (input) => {
            await updateReview.mutateAsync(input);
            setIsEditing(false);
          }}
        />
      </section>
    );
  }

  return (
    <>
      <YourReview
        review={review}
        onEdit={() => setIsEditing(true)}
        onDelete={() => setIsConfirmingDelete(true)}
      />
      <DeleteReviewDialog
        open={isConfirmingDelete}
        onOpenChange={setIsConfirmingDelete}
        reviewTitle={review.title}
        onConfirm={() => deleteReview.mutateAsync()}
      />
    </>
  );
}
