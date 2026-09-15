// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/errors';
import { ReviewForm } from './review-form';

const VALID_TITLE = 'Good lamp';
const VALID_BODY = 'It has worked well for two months.';

async function fillValidForm(): Promise<void> {
  await userEvent.click(screen.getByRole('radio', { name: '4 stars' }));
  await userEvent.type(screen.getByLabelText(/title/i), VALID_TITLE);
  await userEvent.type(screen.getByLabelText(/review/i), VALID_BODY);
}

describe('ReviewForm', () => {
  it('disables submission until the form is valid', async () => {
    render(<ReviewForm productId="p1" onSubmit={vi.fn()} />);

    expect(screen.getByRole('button', { name: /submit/i })).toBeDisabled();

    await userEvent.click(screen.getByRole('radio', { name: '4 stars' }));
    await userEvent.type(screen.getByLabelText(/title/i), VALID_TITLE);
    await userEvent.type(screen.getByLabelText(/review/i), VALID_BODY);

    expect(screen.getByRole('button', { name: /submit/i })).toBeEnabled();
  });

  it('exposes the rating as a radio group so arrow keys and screen readers work', () => {
    render(<ReviewForm productId="p1" onSubmit={vi.fn()} />);

    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(5);
    expect(screen.getByRole('radio', { name: '1 star' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: '5 stars' })).toBeInTheDocument();
  });

  it('shows the same validation messages the API enforces', async () => {
    render(<ReviewForm productId="p1" onSubmit={vi.fn()} />);

    const bodyField = screen.getByLabelText(/review/i);
    await userEvent.type(bodyField, 'short');
    await userEvent.tab();

    expect(await screen.findByText(/at least 10 character/i)).toBeInTheDocument();
  });

  it('explains a 409 in place rather than as a generic error', async () => {
    const onSubmit = vi.fn().mockRejectedValue(new ApiError(409, 'you have already reviewed this product'));
    render(<ReviewForm productId="p1" onSubmit={onSubmit} />);

    await fillValidForm();
    await userEvent.click(screen.getByRole('button', { name: /submit/i }));

    expect(await screen.findByText(/already reviewed/i)).toBeInTheDocument();
  });

  it('keeps the entered text when submission fails', async () => {
    const onSubmit = vi.fn().mockRejectedValue(new ApiError(500, 'server exploded'));
    render(<ReviewForm productId="p1" onSubmit={onSubmit} />);

    await fillValidForm();
    await userEvent.click(screen.getByRole('button', { name: /submit/i }));

    await screen.findByText(/server exploded/i);

    expect(screen.getByLabelText(/title/i)).toHaveValue(VALID_TITLE);
    expect(screen.getByLabelText(/review/i)).toHaveValue(VALID_BODY);
  });

  it('calls onSubmit with the validated rating, title, and body', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<ReviewForm productId="p1" onSubmit={onSubmit} />);

    await fillValidForm();
    await userEvent.click(screen.getByRole('button', { name: /submit/i }));

    expect(onSubmit).toHaveBeenCalledWith({ rating: 4, title: VALID_TITLE, body: VALID_BODY });
  });
});
