// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReviewDto } from '@reviews/contracts';
import { WriteReviewSection } from './write-review-section';

const refresh = vi.fn();
let myReviewData: ReviewDto | null = null;

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh }),
}));

vi.mock('@/hooks/use-my-review', () => ({
  useMyReview: () => ({ data: myReviewData, isPending: false, isError: false }),
  myReviewQueryKey: (productId: string) => ['me', 'reviews', productId],
}));

vi.mock('@/hooks/use-submit-review', () => ({
  useSubmitReview: () => ({ mutateAsync: vi.fn() }),
}));

// Stubbed so this file tests only the refresh decision, not the panel's
// own controls — those are covered in your-review-section.test.tsx.
vi.mock('@/components/your-review-section', () => ({
  YourReviewSection: () => <div data-testid="your-review" />,
}));

function review(overrides: Partial<ReviewDto> = {}): ReviewDto {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    productId: 'p1',
    status: 'PENDING',
    rating: 4,
    title: 'Good lamp',
    body: 'It has worked well for two months.',
    ...overrides,
  } as unknown as ReviewDto;
}

beforeEach(() => {
  vi.useFakeTimers();
  refresh.mockClear();
  myReviewData = null;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('WriteReviewSection: keeping the server-rendered rating summary current', () => {
  it('does not refresh on first render, when nothing has moved yet', () => {
    myReviewData = review({ status: 'APPROVED' });
    render(<WriteReviewSection productId="p1" isSignedIn />);

    act(() => void vi.advanceTimersByTime(5000));
    expect(refresh).not.toHaveBeenCalled();
  });

  it('refreshes when the author’s own review is approved', () => {
    myReviewData = review({ status: 'PENDING' });
    const { rerender } = render(<WriteReviewSection productId="p1" isSignedIn />);

    myReviewData = review({ status: 'APPROVED' });
    rerender(<WriteReviewSection productId="p1" isSignedIn />);

    // The summary is rendered by a Server Component, so nothing else on
    // this page would ever pick the new numbers up.
    expect(refresh).toHaveBeenCalled();
  });

  it('refreshes a second time shortly after, because aggregation lands after moderation', () => {
    myReviewData = review({ status: 'PENDING' });
    const { rerender } = render(<WriteReviewSection productId="p1" isSignedIn />);

    myReviewData = review({ status: 'APPROVED' });
    rerender(<WriteReviewSection productId="p1" isSignedIn />);
    expect(refresh).toHaveBeenCalledTimes(1);

    // A review is marked APPROVED by one consumer and counted into the
    // rating by another, so the status changes fractionally before the
    // numbers do and the first refresh can still read the old projection.
    act(() => void vi.advanceTimersByTime(1500));
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('refreshes when the review is deleted, not only when its status changes', () => {
    myReviewData = review({ status: 'APPROVED' });
    const { rerender } = render(<WriteReviewSection productId="p1" isSignedIn />);

    myReviewData = null;
    rerender(<WriteReviewSection productId="p1" isSignedIn />);

    expect(refresh).toHaveBeenCalled();
  });

  it('does not refresh on a re-render that changed nothing', () => {
    myReviewData = review({ status: 'APPROVED' });
    const { rerender } = render(<WriteReviewSection productId="p1" isSignedIn />);

    rerender(<WriteReviewSection productId="p1" isSignedIn />);
    act(() => void vi.advanceTimersByTime(5000));

    // useMyReview polls every 2s while a review is awaiting moderation;
    // each poll re-renders this component with an identical review.
    // Refreshing on those would re-run the server render every two
    // seconds for as long as the page stays open.
    expect(refresh).not.toHaveBeenCalled();
  });
});
