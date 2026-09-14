import type { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';
import { REDIS_CLIENT } from '../src/common/redis/redis.constants.js';
import { createProduct } from './fixtures.js';
import { createTestApp, setupTestApp } from './harness.js';

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

/**
 * The throttler storage keys observed in practice (see throttle.module.ts)
 * are `{hash:name}:hits` / `{hash:name}:blocked`. Filtering `redis.keys('*')`
 * down to this suffix, rather than asserting on `dbsize()`, keeps the
 * assertion pinned to throttler state specifically even if some other
 * cache entry happens to exist in the same Redis database.
 */
async function throttlerKeys(redis: Redis): Promise<string[]> {
  const all = await redis.keys('*');
  return all.filter((key) => key.endsWith(':hits') || key.endsWith(':blocked'));
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

  // Redis is unreachable for the whole app in this one test (a fresh app
  // via createTestApp, not the shared ctx — see cache.integration.test.ts's
  // "cache resilience" describe block for the same pattern and why port 1
  // fails fast with ECONNREFUSED instead of hanging). This exercises the
  // fail-open ruling in throttle.module.ts's FailOpenThrottlerStorage doc
  // comment: a broken rate limiter must not take the whole write endpoint
  // down with it.
  it('still accepts a submission when Redis is unreachable', async () => {
    const broken = await createTestApp({ REDIS_URL: 'redis://127.0.0.1:1' });
    try {
      const token = await broken.loginAs('alice@example.com');
      const product = await createProduct(broken.prisma);

      await broken.request.post(`/api/v1/products/${product.id}/reviews`).auth(token, { type: 'bearer' }).send(VALID_PAYLOAD).expect(202);
    } finally {
      await broken.close();
    }
  });

  // Grouped and pinned with `.sequential` deliberately: this pair only
  // proves anything about the Redis flush if the second test runs right
  // after the first, sharing the `afterEach` between them (see
  // setupTestApp in harness.ts). `.sequential` keeps that true even if
  // this file is later split or the suite's run mode changes to allow
  // concurrent tests within a file — plain declaration order alone
  // wouldn't survive either of those.
  //
  // An earlier version of this pair keyed the check off
  // `loginAs('alice@example.com')`'s user id surviving into the next
  // test — but `truncate()` deletes the `users` table between tests
  // (see harness.ts), and `users.id` defaults to `uuid(7)` (see
  // packages/db/prisma/schema.prisma), so the *next* loginAs('alice@...')
  // call creates a brand-new row with a brand-new id. The throttler keys
  // on that id, so the following request always landed on a
  // never-before-seen Redis key and returned 202 whether or not the flush
  // actually ran — the test could not fail for the reason its name
  // claimed. Reading Redis directly, instead of inferring flush behaviour
  // from an HTTP status code tied to an identity that doesn't survive
  // truncation, closes that gap.
  describe.sequential('redis flush covers throttler keys between tests', () => {
    it('leaves throttler keys in redis after a user is blocked', async () => {
      const token = await ctx.loginAs('alice@example.com');
      const [first, second, third] = await Promise.all([
        createProduct(ctx.prisma),
        createProduct(ctx.prisma),
        createProduct(ctx.prisma),
      ]);

      await submit(first.id, token).expect(202);
      await submit(second.id, token).expect(202);
      await submit(third.id, token).expect(429);

      const redis = ctx.app.get<Redis>(REDIS_CLIENT);
      expect((await throttlerKeys(redis)).length).toBeGreaterThan(0);
    });

    it('has no throttler keys left after the harness truncates between tests', async () => {
      const redis = ctx.app.get<Redis>(REDIS_CLIENT);
      expect(await throttlerKeys(redis)).toEqual([]);
    });
  });
});
