import { describe, expect, it } from 'vitest';
import { createReviewInputSchema, reviewSortSchema, updateReviewInputSchema } from './review.js';

describe('createReviewInputSchema', () => {
  it('accepts a well-formed review', () => {
    const parsed = createReviewInputSchema.parse({
      rating: 5,
      title: 'Excellent build quality',
      body: 'Used it daily for three months without a single issue.',
    });
    expect(parsed.rating).toBe(5);
  });

  it.each([0, 6, 2.5])('rejects rating %s', (rating) => {
    expect(() => createReviewInputSchema.parse({ rating, title: 'Fine', body: 'Long enough body.' })).toThrow();
  });

  it('rejects a body shorter than 10 characters', () => {
    expect(() => createReviewInputSchema.parse({ rating: 4, title: 'Fine', body: 'short' })).toThrow();
  });

  it('trims surrounding whitespace from title and body', () => {
    const parsed = createReviewInputSchema.parse({ rating: 4, title: '  Good  ', body: '  Long enough body.  ' });
    expect(parsed.title).toBe('Good');
  });
});

describe('updateReviewInputSchema', () => {
  it('rejects an empty patch', () => {
    expect(() => updateReviewInputSchema.parse({})).toThrow();
  });

  it('accepts a rating-only patch', () => {
    expect(updateReviewInputSchema.parse({ rating: 3 })).toEqual({ rating: 3 });
  });
});

describe('reviewSortSchema', () => {
  it('defaults to helpful', () => {
    expect(reviewSortSchema.parse(undefined)).toBe('helpful');
  });

  it('rejects an unknown sort', () => {
    expect(() => reviewSortSchema.parse('cheapest')).toThrow();
  });
});
