import { describe, expect, it } from 'vitest';
import { defaultPolicy } from './policy.js';
import type { ModerationInput } from './policy.types.js';

const base: ModerationInput = {
  title: 'Solid product',
  body: 'Used it for two months and it still works perfectly.',
  rating: 4,
  verifiedPurchase: false,
  authorPreviousBodies: [],
};
const classify = (over: Partial<typeof base> = {}) => defaultPolicy.classify({ ...base, ...over });

describe('defaultPolicy', () => {
  it('approves an ordinary review', () => {
    expect(classify()).toEqual({ decision: 'APPROVED', reason: null });
  });

  it('rejects a review containing a banned word', () => {
    const verdict = classify({ body: 'This is complete garbage, you damn sellers.' });
    expect(verdict.decision).toBe('REJECTED');
    expect(verdict.reason).toMatch(/language/i);
  });

  it('rejects a review that is mostly links', () => {
    const verdict = classify({ body: 'Buy cheaper at http://a.example http://b.example http://c.example' });
    expect(verdict.decision).toBe('REJECTED');
    expect(verdict.reason).toMatch(/link/i);
  });

  it('flags shouting rather than rejecting it', () => {
    expect(classify({ body: 'ABSOLUTELY TERRIBLE DO NOT BUY THIS EVER AGAIN' }).decision).toBe('FLAGGED');
  });

  it('flags a review duplicated from the same author', () => {
    const body = 'Used it for two months and it still works perfectly.';
    expect(classify({ body, authorPreviousBodies: [body] }).decision).toBe('FLAGGED');
  });

  it('flags long runs of repeated characters', () => {
    expect(classify({ body: 'Greaaaaaaaaaaaaat product, really greaaaaaaaat.' }).decision).toBe('FLAGGED');
  });

  it('approves a borderline review from a verified purchaser', () => {
    const shouty = { body: 'ABSOLUTELY TERRIBLE DO NOT BUY THIS EVER AGAIN' };
    expect(classify({ ...shouty, verifiedPurchase: false }).decision).toBe('FLAGGED');
    expect(classify({ ...shouty, verifiedPurchase: true }).decision).toBe('APPROVED');
  });

  it('does not let a verified purchase rescue a rejection', () => {
    expect(classify({ body: 'You damn sellers.', verifiedPurchase: true }).decision).toBe('REJECTED');
  });

  it('checks the title as well as the body', () => {
    expect(classify({ title: 'ABSOLUTE CRAP' }).decision).toBe('REJECTED');
  });

  it('is a pure function', () => {
    const input = { ...base };
    const snapshot = structuredClone(input);
    defaultPolicy.classify(input);
    expect(input).toEqual(snapshot);
  });

  it.each([
    ['a one-word body under the caps rule', 'OK'],
    ['an acronym-heavy but normal review', 'The USB-C PD charging works with my MBP and my XPS.'],
  ])('does not flag %s', (_label, body) => {
    expect(classify({ body }).decision).toBe('APPROVED');
  });
});
