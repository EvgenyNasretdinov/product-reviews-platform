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

  // This exact string is what the README's walkthrough tells a reader to
  // paste in order to watch automatic moderation work. The first version
  // of that walkthrough suggested a 33-character one, which is under
  // CAPS_MIN_LENGTH and therefore approved — the walkthrough demonstrated
  // nothing, and said so nowhere. Pinning the string here is what makes a
  // retuned threshold fail in this file instead of in someone's first ten
  // minutes with the project.
  it('flags shouting rather than rejecting it, using the README\'s own example', () => {
    const readmeExample = 'ABSOLUTELY TERRIBLE DO NOT BUY THIS EVER AGAIN';
    expect(readmeExample.length).toBeGreaterThan(40);
    expect(classify({ body: readmeExample }).decision).toBe('FLAGGED');
  });

  it('leaves a short burst of capitals alone, so acronyms are not shouting', () => {
    expect(classify({ body: 'SUPER BADD' }).decision).toBe('APPROVED');
    expect(classify({ body: 'Battery life on the MBP with USB-C is great.' }).decision).toBe('APPROVED');
  });

  // The seed's one FLAGGED fixture (packages/db/prisma/seed.ts) hardcodes
  // both this body and the reason beside it, so that the moderation queue
  // shows a review whose verdict the classifier would genuinely reach.
  // It previously claimed a "suspicious external link" on a body with no
  // link and no rule behind it. This keeps the two from drifting apart
  // again: change a threshold and the fixture stops being reproducible
  // here, rather than on the screen.
  it("flags the seed's FLAGGED fixture, with the reason the seed stores", () => {
    const verdict = classify({ body: 'TOTAL WASTE OF MONEY AND IT BROKE WITHIN A WEEK OF NORMAL USE' });
    expect(verdict).toEqual({
      decision: 'FLAGGED',
      reason: 'Review appears to be shouting (excessive uppercase).',
    });
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
