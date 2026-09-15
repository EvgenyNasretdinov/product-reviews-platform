// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { RatingSummary } from './rating-summary';

const fourReviews = {
  reviewCount: 4,
  averageRating: 3.75,
  distribution: { 1: 1, 2: 0, 3: 0, 4: 1, 5: 2 },
};

const noReviews = {
  reviewCount: 0,
  averageRating: 0,
  distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
};

describe('RatingSummary', () => {
  it('renders each star row as a percentage of the total', () => {
    render(<RatingSummary summary={fourReviews} onFilter={vi.fn()} activeFilter={null} />);
    expect(screen.getByRole('button', { name: '5 stars, 2 reviews, 50%' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '2 stars, 0 reviews, 0%' })).toBeInTheDocument();
  });

  it('calls onFilter with the star value when a row is activated', async () => {
    const onFilter = vi.fn();
    render(<RatingSummary summary={fourReviews} onFilter={onFilter} activeFilter={null} />);
    await userEvent.click(screen.getByRole('button', { name: /5 stars/ }));
    expect(onFilter).toHaveBeenCalledWith(5);
  });

  it('clears the filter when the active row is activated again', async () => {
    const onFilter = vi.fn();
    render(<RatingSummary summary={fourReviews} onFilter={onFilter} activeFilter={5} />);
    await userEvent.click(screen.getByRole('button', { name: /5 stars/ }));
    expect(onFilter).toHaveBeenCalledWith(null);
  });

  it('divides by zero safely when a product has no reviews', () => {
    render(<RatingSummary summary={noReviews} onFilter={vi.fn()} activeFilter={null} />);
    expect(screen.getByText(/no reviews yet/i)).toBeInTheDocument();
    expect(screen.queryByText('NaN%')).not.toBeInTheDocument();
  });
});
