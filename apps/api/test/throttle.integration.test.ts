import { describe, expect, it } from 'vitest';
import { createProduct } from './fixtures.js';
import { setupTestApp } from './harness.js';

/**
 * Booted with a tight limit (2/hour) instead of the canonical default (5)
 * so this suite doesn't need six requests to prove the cap — see
 * harness.ts's BASE_TEST_ENV doc comment for why this override is scoped
 * to this file's worker calls and never leaks into any other suite
 * sharing the same Postgres/Redis containers.
 */
const ctx = setupTestApp({ REVIEW_SUBMIT_RATE_LIMIT: '2' });

const VALID_PAYLOAD = {
  rating: 5,
  title: 'Solid buy overall',
  body: 'Works exactly as advertised, would recommend to a friend.',
};

function submit(productId: string, token: string) {
  return ctx.request.post(`/api/v1/products/${productId}/reviews`).auth(token, { type: 'bearer' }).send(VALID_PAYLOAD);
}

describe('review submission rate limiting', () => {
  // Case: two submissions to two different products succeed; the third
  // returns 429 with a numeric Retry-After. A client that can't parse
  // Retry-After has to guess when to retry, and guesses badly (usually by
  // retrying immediately) — so this checks it's actually a number, not
  // just present.
  it('allows submissions up to the limit, then blocks the next one with 429 and a numeric Retry-After', async () => {
    const token = await ctx.loginAs('alice@example.com');
    const [first, second, third] = await Promise.all([
      createProduct(ctx.prisma),
      createProduct(ctx.prisma),
      createProduct(ctx.prisma),
    ]);

    await submit(first.id, token).expect(202);
    await submit(second.id, token).expect(202);
    const blocked = await submit(third.id, token).expect(429);

    const retryAfter = Number(blocked.headers['retry-after']);
    expect(blocked.headers['retry-after']).toBeDefined();
    expect(Number.isFinite(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
  });

  // Deliberately depends on the previous test having exhausted (and
  // blocked) alice's quota, and on setupTestApp's afterEach truncate()
  // flushing Redis between tests (see harness.ts: it does this via
  // `cache.delByPrefix('')`, a whole-keyspace SCAN+DEL over the same
  // shared ioredis client the throttler storage is built on). If the
  // throttler's own keys weren't covered by that flush, this request
  // would still see alice as blocked and come back 429 instead of 202 —
  // which is exactly the "passes in isolation, fails after another suite"
  // failure mode this is checking for, just made to happen one test over
  // instead of one suite over.
  it('does not leak a blocked user\'s counter into the next test', async () => {
    const token = await ctx.loginAs('alice@example.com');
    const product = await createProduct(ctx.prisma);

    await submit(product.id, token).expect(202);
  });

  // Case: a different user is unaffected by the first user's exhaustion —
  // proves the throttle key is per-user, not global or per-process.
  it('does not affect a different user when the first user is exhausted', async () => {
    const aliceToken = await ctx.loginAs('alice@example.com');
    const bobToken = await ctx.loginAs('bob@example.com');
    const [first, second, third] = await Promise.all([
      createProduct(ctx.prisma),
      createProduct(ctx.prisma),
      createProduct(ctx.prisma),
    ]);

    await submit(first.id, aliceToken).expect(202);
    await submit(second.id, aliceToken).expect(202);
    await submit(third.id, aliceToken).expect(429);

    // Bob reviewing a product alice already reviewed is fine — the
    // one-review-per-author-per-product constraint is scoped to the
    // author, not the product.
    await submit(first.id, bobToken).expect(202);
  });

  // Case: GET endpoints are never throttled. Targets the list route on
  // this same controller — the one a browsing visitor would plausibly hit
  // repeatedly — and sends more requests than the 2/hour submit limit
  // configured for this suite to prove the guard isn't accidentally
  // catching the whole controller.
  it('never throttles GET /api/v1/products/:productId/reviews', async () => {
    const product = await createProduct(ctx.prisma);

    await ctx.request.get(`/api/v1/products/${product.id}/reviews`).expect(200);
    await ctx.request.get(`/api/v1/products/${product.id}/reviews`).expect(200);
    await ctx.request.get(`/api/v1/products/${product.id}/reviews`).expect(200);
  });
});
