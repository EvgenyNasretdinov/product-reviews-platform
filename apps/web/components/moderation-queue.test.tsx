// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ModerationReviewDto } from '@reviews/contracts';
import { ModerationQueue } from './moderation-queue';

function buildReview(overrides: Partial<ModerationReviewDto> = {}): ModerationReviewDto {
  return {
    id: 'review-1',
    productId: 'product-1',
    product: { name: 'Aurora Desk Lamp', slug: 'aurora-desk-lamp' },
    author: { id: 'author-1', displayName: 'Liam O’Connor' },
    rating: 1,
    title: 'Would not recommend',
    body: 'Poor build quality. Not worth the price. Arrived with a crack in the base.',
    status: 'FLAGGED',
    verifiedPurchase: false,
    helpfulCount: 0,
    notHelpfulCount: 0,
    createdAt: new Date('2026-08-15T08:10:55.134Z'),
    publishedAt: null,
    moderationReason: 'Review appears to be shouting (excessive uppercase).',
    ...overrides,
  };
}

describe('ModerationQueue', () => {
  it("renders each review's full body, product, author, rating, and the reason it was flagged", () => {
    const review = buildReview();
    render(<ModerationQueue reviews={[review]} onDecide={vi.fn()} />);

    expect(screen.getByText(review.body)).toBeInTheDocument();
    expect(screen.getByText(review.author.displayName)).toBeInTheDocument();
    expect(screen.getByText(/excessive uppercase/i)).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /1 out of 5 stars/i })).toBeInTheDocument();

    // The product: shown by name (not a bare id), linked to its own page
    // so a moderator can see this review in context in one click.
    const productLink = screen.getByRole('link', { name: review.product.name });
    expect(productLink).toHaveAttribute('href', `/products/${review.product.slug}`);
  });

  it('renders the "Flagged automatically" label once, not doubled by the stored reason', () => {
    // The queue prints that label itself. The seeded fixture used to carry
    // the same words inside moderationReason as well, so the screen read
    // "Flagged automatically: Flagged automatically: ...".
    render(<ModerationQueue reviews={[buildReview()]} onDecide={vi.fn()} />);

    expect(document.body.textContent).not.toMatch(/Flagged automatically:\s*Flagged automatically/i);
  });

  it("links each review's product row to that review's own product, not a shared one", () => {
    const lamp = buildReview({ id: 'review-lamp', product: { name: 'Aurora Desk Lamp', slug: 'aurora-desk-lamp' } });
    const kettle = buildReview({
      id: 'review-kettle',
      title: 'Leaks from the base',
      product: { name: 'Steel Electric Kettle', slug: 'steel-electric-kettle' },
    });
    render(<ModerationQueue reviews={[lamp, kettle]} onDecide={vi.fn()} />);

    expect(screen.getByRole('link', { name: 'Aurora Desk Lamp' })).toHaveAttribute(
      'href',
      '/products/aurora-desk-lamp',
    );
    expect(screen.getByRole('link', { name: 'Steel Electric Kettle' })).toHaveAttribute(
      'href',
      '/products/steel-electric-kettle',
    );
  });

  it('omits the flagged-reason panel for a review with no moderation reason', () => {
    const review = buildReview({ id: 'review-2', status: 'PENDING', moderationReason: null });
    render(<ModerationQueue reviews={[review]} onDecide={vi.fn()} />);

    expect(screen.queryByText(/flagged automatically/i)).not.toBeInTheDocument();
  });

  it('calls onDecide with APPROVED and no reason when Approve is clicked', async () => {
    const review = buildReview();
    const onDecide = vi.fn().mockResolvedValue(undefined);
    render(<ModerationQueue reviews={[review]} onDecide={onDecide} />);

    await userEvent.click(screen.getByRole('button', { name: /approve/i }));

    expect(onDecide).toHaveBeenCalledWith(review.id, 'APPROVED', null);
  });

  it('removes an approved review from the list once the decision succeeds', async () => {
    const review = buildReview();
    const onDecide = vi.fn().mockResolvedValue(undefined);
    render(<ModerationQueue reviews={[review]} onDecide={onDecide} />);

    await userEvent.click(screen.getByRole('button', { name: /approve/i }));

    expect(await screen.findByText(/nothing to review/i)).toBeInTheDocument();
    expect(screen.queryByText(review.body)).not.toBeInTheDocument();
  });

  it('keeps a review in the list and shows a message when approving it fails', async () => {
    const review = buildReview();
    const onDecide = vi.fn().mockRejectedValue(new Error('server exploded'));
    render(<ModerationQueue reviews={[review]} onDecide={onDecide} />);

    await userEvent.click(screen.getByRole('button', { name: /approve/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/server exploded/i);
    expect(screen.getByText(review.body)).toBeInTheDocument();
  });

  it('opens a real dialog with a form when Reject is clicked, not window.confirm', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    const review = buildReview();
    render(<ModerationQueue reviews={[review]} onDecide={vi.fn()} />);

    await userEvent.click(screen.getByRole('button', { name: /^reject$/i }));

    const dialog = await screen.findByRole('dialog');
    const reasonField = within(dialog).getByRole('textbox', { name: /reason/i });
    expect(reasonField).toBeInTheDocument();
    expect(dialog.querySelector('form')).not.toBeNull();
    expect(confirmSpy).not.toHaveBeenCalled();

    // The focus trap: Radix moves focus into the dialog on open (here,
    // onto the reason field, via its `autoFocus`) rather than leaving it
    // on the "Reject" button behind an overlay — the behaviour
    // `window.confirm` has no equivalent of.
    expect(document.activeElement).toBe(reasonField);

    await userEvent.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('keeps the confirm button disabled until a reason is entered, then calls onDecide with REJECTED and the reason', async () => {
    const review = buildReview();
    const onDecide = vi.fn().mockResolvedValue(undefined);
    render(<ModerationQueue reviews={[review]} onDecide={onDecide} />);

    await userEvent.click(screen.getByRole('button', { name: /^reject$/i }));
    const dialog = await screen.findByRole('dialog');
    const confirmButton = within(dialog).getByRole('button', { name: /reject review/i });

    expect(confirmButton).toBeDisabled();

    await userEvent.type(within(dialog).getByRole('textbox', { name: /reason/i }), 'Contains a spam link');
    expect(confirmButton).toBeEnabled();

    await userEvent.click(confirmButton);

    expect(onDecide).toHaveBeenCalledWith(review.id, 'REJECTED', 'Contains a spam link');
  });

  it('removes a rejected review from the list once the decision succeeds, and closes the dialog', async () => {
    const review = buildReview();
    const onDecide = vi.fn().mockResolvedValue(undefined);
    render(<ModerationQueue reviews={[review]} onDecide={onDecide} />);

    await userEvent.click(screen.getByRole('button', { name: /^reject$/i }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByRole('textbox', { name: /reason/i }), 'Off-topic content');
    await userEvent.click(within(dialog).getByRole('button', { name: /reject review/i }));

    expect(await screen.findByText(/nothing to review/i)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('keeps the dialog open and shows a message when rejecting fails, without discarding the typed reason', async () => {
    const review = buildReview();
    const onDecide = vi.fn().mockRejectedValue(new Error('the review was already decided'));
    render(<ModerationQueue reviews={[review]} onDecide={onDecide} />);

    await userEvent.click(screen.getByRole('button', { name: /^reject$/i }));
    const dialog = await screen.findByRole('dialog');
    const reasonField = within(dialog).getByRole('textbox', { name: /reason/i });
    await userEvent.type(reasonField, 'Off-topic content');
    await userEvent.click(within(dialog).getByRole('button', { name: /reject review/i }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/already decided/i);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(reasonField).toHaveValue('Off-topic content');
  });

  it('shows a clear empty-queue message rather than a blank panel when there is nothing to review', () => {
    render(<ModerationQueue reviews={[]} onDecide={vi.fn()} />);

    expect(screen.getByText(/nothing to review/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument();
  });

  it('accepts custom empty-state copy for a queue scoped to one status', () => {
    render(
      <ModerationQueue
        reviews={[]}
        onDecide={vi.fn()}
        emptyTitle="No pending reviews"
        emptyDescription="Every submitted review has been classified."
      />,
    );

    expect(screen.getByText('No pending reviews')).toBeInTheDocument();
  });
});
