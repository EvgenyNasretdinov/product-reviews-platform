import { cacheKeys } from '@reviews/contracts';
import { describe, expect, it, vi } from 'vitest';
import { CacheService } from '../src/common/cache/cache.service.js';
import { createProduct } from './fixtures.js';
import { setupTestApp, type TestContext } from './harness.js';

const ctx = setupTestApp();

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
