// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RatingStars } from './rating-stars';

describe('RatingStars', () => {
  it('announces the rating as text for assistive technology', () => {
    render(<RatingStars value={3.75} count={12} />);
    expect(screen.getByRole('img', { name: '3.75 out of 5 stars, 12 reviews' })).toBeInTheDocument();
  });

  it('renders a zero rating without reviews as unrated', () => {
    render(<RatingStars value={0} count={0} />);
    expect(screen.getByRole('img', { name: 'No reviews yet' })).toBeInTheDocument();
  });

  it('clamps out-of-range values instead of overflowing the row', () => {
    render(<RatingStars value={7} count={1} />);
    expect(screen.getByRole('img', { name: /5 out of 5/ })).toBeInTheDocument();
  });
});
