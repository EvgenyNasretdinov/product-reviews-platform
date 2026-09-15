'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { ReviewForm } from '@/components/review-form';
import { YourReview } from '@/components/your-review';
import { useMyReview } from '@/hooks/use-my-review';
import { useSubmitReview } from '@/hooks/use-submit-review';

interface WriteReviewSectionProps {
  productId: string;
  isSignedIn: boolean;
}

/**
 * The piece that decides, for the signed-in visitor looking at this
 * product, whether they see the form to write a review or the "Your
 * review" panel for the one they already wrote — never both, and never
 * neither. This is the composing layer `ReviewForm`, `YourReview`, and
 * their two hooks were deliberately kept ignorant of: `ReviewForm` only
 * knows how to validate and submit, `YourReview` only knows how to
 * display, and this component is what decides which of them the moment
 * calls for.
 *
 * `useMyReview`'s success — its data going from `null` to a `ReviewDto` —
 * is also what makes a submission "take": `useSubmitReview` invalidates
 * `['me', 'reviews']` on success, this component's `useMyReview` query
 * refetches, and the very next render swaps the form out for the panel.
 * There's no separate "submitted!" state to manage by hand.
 */
export function WriteReviewSection({ productId, isSignedIn }: WriteReviewSectionProps): ReactNode {
  const myReview = useMyReview(productId, isSignedIn);
  const submitReview = useSubmitReview(productId);

  if (!isSignedIn) {
    return (
      <p className="text-sm text-muted-foreground">
        <Link href="/login" className="font-medium underline-offset-4 hover:underline">
          Sign in
        </Link>{' '}
        to write a review.
      </p>
    );
  }

  // While the "does this signed-in visitor already have a review" check
  // is in flight, render nothing rather than a skeleton for either
  // branch: guessing wrong (showing the form, then swapping to the panel
  // a moment later, or vice versa) is more jarring than a brief blank
  // beat in a section that isn't the page's primary content.
  if (myReview.isPending) {
    return null;
  }

  if (myReview.isError) {
    return (
      <p className="text-sm text-destructive">
        Couldn&rsquo;t check whether you&rsquo;ve already reviewed this product. Refresh to try again.
      </p>
    );
  }

  if (myReview.data) {
    return <YourReview review={myReview.data} />;
  }

  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold">Write a review</h2>
      <ReviewForm productId={productId} onSubmit={(input) => submitReview.mutateAsync(input)} />
    </div>
  );
}
