// @vitest-environment jsdom
import { act } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/errors';
import { VoteButtons } from './vote-buttons';

describe('VoteButtons', () => {
  it('renders the helpful and not-useful counts', () => {
    render(<VoteButtons reviewId="r1" helpfulCount={3} notHelpfulCount={1} onVote={vi.fn()} canVote />);

    const helpfulButton = screen.getByRole('button', { name: /helpful/i });
    const notUsefulButton = screen.getByRole('button', { name: /not useful/i });

    expect(within(helpfulButton).getByText('3')).toBeInTheDocument();
    expect(within(notUsefulButton).getByText('1')).toBeInTheDocument();
  });

  it('increments the helpful count optimistically before the vote request settles', async () => {
    let resolveVote: (() => void) | undefined;
    const onVote = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveVote = resolve;
        }),
    );
    render(<VoteButtons reviewId="r1" helpfulCount={3} notHelpfulCount={0} onVote={onVote} canVote />);

    await userEvent.click(screen.getByRole('button', { name: /helpful/i }));

    expect(within(screen.getByRole('button', { name: /helpful/i })).getByText('4')).toBeInTheDocument();

    // Let the pending promise settle so this test doesn't leak a dangling
    // update into the next one.
    await act(async () => {
      resolveVote?.();
      await Promise.resolve();
    });
  });

  it('clears the vote when the active button is clicked again, rather than stacking', async () => {
    const onVote = vi.fn().mockResolvedValue(undefined);
    render(<VoteButtons reviewId="r1" helpfulCount={3} notHelpfulCount={0} onVote={onVote} canVote />);
    const helpfulButton = screen.getByRole('button', { name: /helpful/i });

    await userEvent.click(helpfulButton);
    expect(within(helpfulButton).getByText('4')).toBeInTheDocument();
    expect(helpfulButton).toHaveAttribute('aria-pressed', 'true');

    await userEvent.click(helpfulButton);
    expect(within(helpfulButton).getByText('3')).toBeInTheDocument();
    expect(helpfulButton).toHaveAttribute('aria-pressed', 'false');

    expect(onVote).toHaveBeenNthCalledWith(1, 'HELPFUL', null);
    expect(onVote).toHaveBeenNthCalledWith(2, null, 'HELPFUL');
  });

  it('moves the vote from helpful to not-useful instead of stacking both', async () => {
    const onVote = vi.fn().mockResolvedValue(undefined);
    render(<VoteButtons reviewId="r1" helpfulCount={3} notHelpfulCount={0} onVote={onVote} canVote />);
    const helpfulButton = screen.getByRole('button', { name: /helpful/i });
    const notUsefulButton = screen.getByRole('button', { name: /not useful/i });

    await userEvent.click(helpfulButton);
    await userEvent.click(notUsefulButton);

    expect(within(helpfulButton).getByText('3')).toBeInTheDocument();
    expect(within(notUsefulButton).getByText('1')).toBeInTheDocument();
    expect(onVote).toHaveBeenLastCalledWith('NOT_HELPFUL', 'HELPFUL');
  });

  it('rolls the count back when the request fails', async () => {
    const vote = vi.fn().mockRejectedValue(new ApiError(500, 'boom'));
    render(<VoteButtons reviewId="r1" helpfulCount={4} notHelpfulCount={0} onVote={vote} canVote />);
    await userEvent.click(screen.getByRole('button', { name: /helpful/i }));
    expect(await screen.findByText('4')).toBeInTheDocument();
  });

  it('shows an inline message when the vote request fails', async () => {
    const onVote = vi.fn().mockRejectedValue(new ApiError(500, 'boom'));
    render(<VoteButtons reviewId="r1" helpfulCount={4} notHelpfulCount={0} onVote={onVote} canVote />);

    await userEvent.click(screen.getByRole('button', { name: /helpful/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn.?t record your vote/i);
  });

  it("renders only the counts for the review's own author, with no vote controls", () => {
    render(
      <VoteButtons reviewId="r1" helpfulCount={2} notHelpfulCount={1} onVote={vi.fn()} canVote={false} isSignedIn />,
    );

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByText(/2 of 3 found this helpful/i)).toBeInTheDocument();
  });

  it('prompts a signed-out visitor to sign in instead of showing buttons that would fail', () => {
    render(
      <VoteButtons
        reviewId="r1"
        helpfulCount={2}
        notHelpfulCount={1}
        onVote={vi.fn()}
        canVote={false}
        isSignedIn={false}
      />,
    );

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /sign in/i })).toBeInTheDocument();
    expect(screen.getByText(/2 of 3 found this helpful/i)).toBeInTheDocument();
  });
});
