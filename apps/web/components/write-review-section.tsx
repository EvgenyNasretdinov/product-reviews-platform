'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, type ReactNode } from 'react';
import { ReviewForm } from '@/components/review-form';
import { YourReviewSection } from '@/components/your-review-section';
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
  useRefreshWhenOwnReviewChanges(myReview.data ?? null);

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
    return <YourReviewSection productId={productId} review={myReview.data} />;
  }

  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold">Write a review</h2>
      <ReviewForm productId={productId} onSubmit={(input) => submitReview.mutateAsync(input)} />
    </div>
  );
}

/**
 * The rating summary at the top of this page — the average, the count,
 * the histogram — is rendered by a Server Component (see
 * app/products/[slug]/page.tsx) and is therefore fixed for the life of
 * that render. Everything else on the page reacts on its own: the review
 * list is a client query, and `useMyReview` polls while a review is
 * awaiting moderation. The summary was the one thing that did not, so an
 * author watching their own review turn from "Awaiting moderation" to
 * published saw the count beside it stay put until they reloaded.
 *
 * `router.refresh()` re-runs the server render in place, which is what
 * makes the summary catch up without losing client state or scroll
 * position.
 *
 * It fires twice on purpose. Moderation and aggregation are two separate
 * consumers of two separate events: a review is marked APPROVED first,
 * and only then does `review.approved` reach the consumer that recomputes
 * the product's rating. The status this hook is watching therefore
 * changes slightly *before* the numbers do, so a single refresh at that
 * moment can still read the previous projection. The second pass, a beat
 * later, is what catches it. Refreshing one extra time costs one server
 * render of a page the visitor is already looking at.
 */
function useRefreshWhenOwnReviewChanges(review: { id: string; status: string } | null): void {
  const router = useRouter();
  const previous = useRef<string | null>(null);

  // Identity and status together: a delete (review -> null) and an edit
  // that sends an approved review back to PENDING both move the rating,
  // and neither is a plain status change on a stable row.
  const signature = review ? `${review.id}:${review.status}` : 'none';

  useEffect(() => {
    const isFirstObservation = previous.current === null;
    const changed = previous.current !== signature;
    previous.current = signature;

    // Nothing has moved yet on the first pass — this is just the page as
    // it was rendered, and refreshing it would be a wasted round trip on
    // every single page load.
    if (isFirstObservation || !changed) {
      return;
    }

    router.refresh();
    const timer = setTimeout(() => router.refresh(), 1500);
    return () => clearTimeout(timer);
  }, [signature, router]);
}
