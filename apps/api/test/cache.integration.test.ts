import { randomUUID } from 'node:crypto';
import { cacheKeys } from '@reviews/contracts';
import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import { CacheService } from '../src/common/cache/cache.service.js';
import { REDIS_CLIENT } from '../src/common/redis/redis.constants.js';
import { createProduct } from './fixtures.js';
import { createTestApp, setupTestApp, type TestContext } from './harness.js';

const ctx = setupTestApp();

/**
 * Walks a keyspace with batched `SCAN` and collects every matching key —
 * the same "no `KEYS`" discipline `RedisCacheService.delByPrefix` follows
 * in production, reused here purely as a test assertion helper so this
 * file doesn't reach for the one command that discipline exists to avoid.
 */
async function scanAll(redis: Redis, pattern: string): Promise<string[]> {
  const found: string[] = [];
  let cursor = '0';
  do {
    const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 1000);
    cursor = nextCursor;
    found.push(...keys);
  } while (cursor !== '0');
  return found;
}

/**
 * `vi.spyOn(ctx.prisma.product, 'findUnique')` alone breaks the query it
 * wraps: Prisma's generated model delegate is a `Proxy` whose
 * `getOwnPropertyDescriptor` trap reports `{ value: undefined, ... }` for
 * every method (a workaround so `Object.defineProperty` — which `vi.spyOn`
 * uses to install the spy — satisfies the Proxy invariants), so the
 * "original implementation" `vi.spyOn` captures to call through to is
 * `undefined`, not the real query function. The spy still records the
 * call, but silently resolves to `undefined` instead of running the query
 * — which is indistinguishable from "not found" and would make every test
 * below pass for the wrong reason. Binding the real method *before*
 * spying and handing it back in as an explicit `mockImplementation` keeps
 * the spy's call-counting behaviour while routing the call to the actual
 * query.
 *
 * `restore` can't be `spy.mockRestore()` for the same reason: restoring
 * writes back whatever `vi.spyOn` captured as "the original value" at
 * spy-creation time, which — because of that lying descriptor — is
 * `undefined`. Calling `mockRestore()` here would permanently null out
 * `findUnique` on this delegate for every later test in the file (every
 * test shares one app, hence one Prisma client, hence one delegate
 * instance). Restoring by plain assignment of the bound original avoids
 * that.
 */
function spyOnFindUnique(context: TestContext) {
  const delegate = context.prisma.product;
  const original = delegate.findUnique.bind(delegate);
  const spy = vi.spyOn(delegate, 'findUnique').mockImplementation(original);
  return {
    spy,
    restore: () => {
      delegate.findUnique = original;
    },
  };
}

describe('product detail cache-aside', () => {
  // Case 1.
  it('hits Postgres once for two consecutive detail requests', async () => {
    const product = await createProduct(ctx.prisma, { slug: 'cache-hit-once' });
    const { spy, restore } = spyOnFindUnique(ctx);

    await ctx.request.get(`/api/v1/products/${product.slug}`).expect(200);
    await ctx.request.get(`/api/v1/products/${product.slug}`).expect(200);

    expect(spy).toHaveBeenCalledTimes(1);
    restore();
  });

  // Case 2.
  it('queries Postgres again after the cache entry is deleted', async () => {
    const product = await createProduct(ctx.prisma, { slug: 'cache-invalidate' });
    const cache = ctx.app.get(CacheService);
    const { spy, restore } = spyOnFindUnique(ctx);

    await ctx.request.get(`/api/v1/products/${product.slug}`).expect(200);
    await cache.del(cacheKeys.productDetail(product.slug));
    await ctx.request.get(`/api/v1/products/${product.slug}`).expect(200);

    expect(spy).toHaveBeenCalledTimes(2);
    restore();
  });

  // Case 3 — the one that actually finds bugs. A response served straight
  // from Prisma and one served from the Redis cache entry it wrote must be
  // byte-identical whole bodies, not just equal on a couple of fields: this
  // is what catches a value that only changes shape on the cache path (for
  // example a Decimal or Date that survives `toProductDetailDto` correctly
  // but loses its type crossing `JSON.stringify`/`JSON.parse`).
  //
  // The sequence deliberately does fetch -> flush -> fetch -> fetch rather
  // than just fetch -> fetch: flushing before the "uncached" fetch makes it
  // a guaranteed cold compute regardless of what an earlier assertion in
  // this file left behind, and the trailing fourth fetch is what actually
  // exercises a cache *hit* — comparing the two fetches on either side of
  // the flush would only ever compare two independently fresh computations
  // and would never touch the cache-read path at all.
  it('returns a payload from the cache identical to a freshly computed one', async () => {
    const product = await createProduct(ctx.prisma, { slug: 'cache-identical-payload' });
    const cache = ctx.app.get(CacheService);

    await ctx.request.get(`/api/v1/products/${product.slug}`).expect(200);
    await cache.del(cacheKeys.productDetail(product.slug));

    const uncached = await ctx.request.get(`/api/v1/products/${product.slug}`).expect(200);
    const cached = await ctx.request.get(`/api/v1/products/${product.slug}`).expect(200);

    expect(cached.body).toEqual(uncached.body);
  });
});

describe('cache resilience', () => {
  // A cache is an optional accelerator, not a hard dependency — a Redis
  // blip must fall through to Postgres, not 500 the hottest read route in
  // the catalogue. `RedisModule` sets `maxRetriesPerRequest: 1` precisely
  // so a hung Redis fails fast; ProductsService must actually catch that
  // fast failure rather than let it propagate. Uses `createTestApp`
  // directly (not the shared `ctx`) because only this one test needs a
  // deliberately unreachable Redis — see health.integration.test.ts for
  // the same pattern against port 1, a reserved, near-universally-closed
  // port that fails fast with ECONNREFUSED instead of hanging.
  it('serves the product from Postgres when Redis is unreachable', async () => {
    const broken = await createTestApp({ REDIS_URL: 'redis://127.0.0.1:1' });
    try {
      const product = await createProduct(broken.prisma, {
        slug: 'cache-down-fallback',
        name: 'Cache Down Fallback',
      });

      const res = await broken.request.get(`/api/v1/products/${product.slug}`).expect(200);

      expect(res.body).toMatchObject({ id: product.id, slug: product.slug, name: product.name });
    } finally {
      await broken.close();
    }
  });
});

describe('harness truncate() and the cache', () => {
  // The enforced-truncation guarantee (every table empty between tests) is
  // only as good as the stores it actually covers. This proves `truncate()`
  // covers Redis too, not just Postgres — without it, a cache entry planted
  // by one test (or one file, since every integration file in this worker
  // shares one Redis container) would survive into the next and could serve
  // a stale DTO with nothing at the failure site pointing at caching.
  it('also clears any cache entry that survived the test', async () => {
    const testApp = await createTestApp();
    try {
      const cache = testApp.app.get(CacheService);
      await cache.set('cache.integration.test:truncate-probe', 'still-here', 60);

      await testApp.truncate();

      await expect(cache.get('cache.integration.test:truncate-probe')).resolves.toBeNull();
    } finally {
      await testApp.close();
    }
  });
});

describe('RedisCacheService.delByPrefix against real Redis', () => {
  // The in-memory implementation's delByPrefix is unit-tested, but its
  // logic (filter + delete over an in-process Map) proves nothing about
  // the Redis implementation's SCAN cursor loop — cursor progression,
  // termination, and batching are the one piece of this task with
  // non-obvious semantics, and the piece most likely to be wrong in a way
  // reading the code doesn't reveal. Seeding comfortably more keys than
  // the 500-key SCAN COUNT hint makes more than one round trip through the
  // cursor loop's `do/while` a near-certainty against a real server.
  it('deletes every matching key across multiple SCAN pages, leaving unrelated keys untouched', async () => {
    const cache = ctx.app.get(CacheService);
    const redis = ctx.app.get<Redis>(REDIS_CLIENT);
    const prefix = `test:scan-prefix:${randomUUID()}:`;
    const matchingCount = 2500;

    const pipeline = redis.pipeline();
    for (let i = 0; i < matchingCount; i += 1) {
      pipeline.set(`${prefix}${i}`, 'x');
    }
    const unrelatedKey = `test:scan-prefix:unrelated:${randomUUID()}`;
    pipeline.set(unrelatedKey, 'keep-me');
    await pipeline.exec();

    await cache.delByPrefix(prefix);

    const remainingMatching = await scanAll(redis, `${prefix}*`);
    expect(remainingMatching).toHaveLength(0);
    expect(await redis.get(unrelatedKey)).toBe('keep-me');

    await redis.del(unrelatedKey);
  });
});
