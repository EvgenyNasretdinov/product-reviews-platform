// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReviewDto } from '@reviews/contracts';
import { YourReviewSection } from './your-review-section';

const updateMutate = vi.fn().mockResolvedValue(undefined);
const deleteMutate = vi.fn().mockResolvedValue(undefined);

// The mutations' own wiring (what they invalidate, how they map status
// codes) is covered in use-manage-review.test.ts against a mocked fetch.
// What this file is for is the layer above: which control leads where,
// and what it takes to reach the irreversible one.
vi.mock('@/hooks/use-manage-review', () => ({
  useUpdateReview: () => ({ mutateAsync: updateMutate }),
  useDeleteReview: () => ({ mutateAsync: deleteMutate }),
}));

const REVIEW: ReviewDto = {
  id: '00000000-0000-4000-8000-000000000001',
  productId: '00000000-0000-4000-8000-0000000000a1',
  author: { id: '00000000-0000-4000-8000-0000000000b1', displayName: 'Alice Johnson' },
  rating: 4,
  title: 'Good lamp',
  body: 'It has worked well for two months.',
  status: 'APPROVED',
  verifiedPurchase: false,
  helpfulCount: 2,
  notHelpfulCount: 0,
  moderationReason: null,
  createdAt: new Date('2026-09-01T10:00:00.000Z'),
  publishedAt: new Date('2026-09-01T10:00:02.000Z'),
} as unknown as ReviewDto;

beforeEach(() => {
  updateMutate.mockClear();
  deleteMutate.mockClear();
});

describe('YourReviewSection', () => {
  it('opens a prefilled form on Edit, rather than a blank one', async () => {
    const user = userEvent.setup();
    render(<YourReviewSection productId={REVIEW.productId} review={REVIEW} />);

    await user.click(screen.getByRole('button', { name: 'Edit' }));

    expect(screen.getByLabelText('Title')).toHaveValue('Good lamp');
    expect(screen.getByLabelText('Review')).toHaveValue('It has worked well for two months.');
    expect(screen.getByRole('radio', { name: '4 stars' })).toBeChecked();
  });

  it('warns that editing sends the review back through moderation', async () => {
    const user = userEvent.setup();
    render(<YourReviewSection productId={REVIEW.productId} review={REVIEW} />);

    await user.click(screen.getByRole('button', { name: 'Edit' }));

    // The API resets an edited review to PENDING and unpublishes it if it
    // was approved. Someone fixing a typo on a live review deserves to
    // know it will leave the public list before they press save.
    expect(screen.getByText(/leaves the public list until it is approved again/i)).toBeInTheDocument();
  });

  it('returns to the panel on Cancel without saving anything', async () => {
    const user = userEvent.setup();
    render(<YourReviewSection productId={REVIEW.productId} review={REVIEW} />);

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.getByTestId('your-review')).toBeInTheDocument();
    expect(updateMutate).not.toHaveBeenCalled();
  });

  it('saves the edited fields and goes back to the panel', async () => {
    const user = userEvent.setup();
    render(<YourReviewSection productId={REVIEW.productId} review={REVIEW} />);

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const title = screen.getByLabelText('Title');
    await user.clear(title);
    await user.type(title, 'Still a good lamp');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(updateMutate).toHaveBeenCalledWith(expect.objectContaining({ title: 'Still a good lamp' }));
    expect(await screen.findByTestId('your-review')).toBeInTheDocument();
  });

  it('does not delete on the first click — Delete only asks', async () => {
    const user = userEvent.setup();
    render(<YourReviewSection productId={REVIEW.productId} review={REVIEW} />);

    await user.click(screen.getByRole('button', { name: 'Delete' }));

    // The API's delete is a hard delete with no undo, so the button that
    // is easy to hit by accident must not be the one that performs it.
    expect(deleteMutate).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toHaveTextContent(/cannot be undone/i);
    expect(screen.getByRole('dialog')).toHaveTextContent('Good lamp');
  });

  it('deletes only after the confirmation is accepted', async () => {
    const user = userEvent.setup();
    render(<YourReviewSection productId={REVIEW.productId} review={REVIEW} />);

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await user.click(screen.getByRole('button', { name: 'Delete review' }));

    expect(deleteMutate).toHaveBeenCalledTimes(1);
  });

  it('deletes nothing when the confirmation is declined', async () => {
    const user = userEvent.setup();
    render(<YourReviewSection productId={REVIEW.productId} review={REVIEW} />);

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await user.click(screen.getByRole('button', { name: 'Keep it' }));

    expect(deleteMutate).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
