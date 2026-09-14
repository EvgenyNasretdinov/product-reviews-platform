import { randomUUID } from 'node:crypto';
import type { ProductDetailDto, RatingSummaryDto } from '@reviews/contracts';
import { describe, expect, it } from 'vitest';
import { createProduct, createReview, createSummary, createUser } from './fixtures.js';
import { setupTestApp } from './harness.js';
import { encodeCursor } from '../src/common/pagination/cursor.js';

// supertest's Response#body is typed `any`; every test below narrows it
// through these shapes once instead of sprinkling eslint-disable comments
// at each access.
interface ProductListBody {
  items: ProductDetailDto[];
  nextCursor: string | null;
}

const ctx = setupTestApp();

const ZERO_DISTRIBUTION: RatingSummaryDto['distribution'] = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };

describe('GET /api/v1/products', () => {
  // Case 1.
  it('returns an empty catalogue', async () => {
    const res = await ctx.request.get('/api/v1/products').expect(200);

    expect(res.body).toEqual({ items: [], nextCursor: null });
  });

  // Case 2.
  it('returns all products ordered by createdAt DESC, id DESC', async () => {
    const oldest = await createProduct(ctx.prisma, { slug: 'oldest', createdAt: new Date('2026-01-01T00:00:00Z') });
    const middle = await createProduct(ctx.prisma, { slug: 'middle', createdAt: new Date('2026-01-02T00:00:00Z') });
    const newest = await createProduct(ctx.prisma, { slug: 'newest', createdAt: new Date('2026-01-03T00:00:00Z') });

    const res = await ctx.request.get('/api/v1/products').expect(200);

    const body = res.body as ProductListBody;
    expect(body.items.map((item) => item.id)).toEqual([newest.id, middle.id, oldest.id]);
    expect(body.nextCursor).toBeNull();
  });

  // Case 3.
  it('paginates with a cursor, covering every product exactly once across pages', async () => {
    const first = await createProduct(ctx.prisma, { slug: 'first', createdAt: new Date('2026-01-01T00:00:00Z') });
    const second = await createProduct(ctx.prisma, { slug: 'second', createdAt: new Date('2026-01-02T00:00:00Z') });
    const third = await createProduct(ctx.prisma, { slug: 'third', createdAt: new Date('2026-01-03T00:00:00Z') });

    const page1 = await ctx.request.get('/api/v1/products?limit=2').expect(200);
    const body1 = page1.body as ProductListBody;
    expect(body1.items.map((item) => item.id)).toEqual([third.id, second.id]);
    expect(body1.nextCursor).not.toBeNull();

    const page2 = await ctx.request.get(`/api/v1/products?limit=2&cursor=${body1.nextCursor}`).expect(200);
    const body2 = page2.body as ProductListBody;
    expect(body2.items.map((item) => item.id)).toEqual([first.id]);
    expect(body2.nextCursor).toBeNull();

    const page1Ids = new Set(body1.items.map((item) => item.id));
    const page2Ids = new Set(body2.items.map((item) => item.id));
    expect([...page1Ids].some((id) => page2Ids.has(id))).toBe(false);
  });

  // Case 4.
  it('matches q case-insensitively on name and skips unrelated products', async () => {
    const chair = await createProduct(ctx.prisma, { slug: 'office-chair', name: 'Ergonomic Office Chair' });
    await createProduct(ctx.prisma, { slug: 'water-bottle', name: 'Insulated Water Bottle' });

    const res = await ctx.request.get('/api/v1/products?q=CHAIR').expect(200);

    const body = res.body as ProductListBody;
    expect(body.items.map((item) => item.id)).toEqual([chair.id]);
  });

  // Case 4, description branch: the `OR` on `description` is a separate
  // code path from the `name` branch above and is otherwise unverified.
  it('matches q case-insensitively on description when the name does not match', async () => {
    const giftBox = await createProduct(ctx.prisma, {
      slug: 'mystery-box',
      name: 'Mystery Box',
      description: 'A surprise gift wrapped in recycled cardboard.',
    });
    await createProduct(ctx.prisma, {
      slug: 'unrelated-gadget',
      name: 'Unrelated Gadget',
      description: 'Does not mention the search term at all.',
    });

    const res = await ctx.request.get('/api/v1/products?q=CARDBOARD').expect(200);

    const body = res.body as ProductListBody;
    expect(body.items.map((item) => item.id)).toEqual([giftBox.id]);
  });

  // Regression test for the `AND`-combined where clause in
  // products.repository.ts. The brief's illustrative `where` snippet spreads
  // a `q`-derived `OR` and a `cursor`-derived `OR` into the same object
  // literal; a plain object can only hold one `OR` key, so the second spread
  // silently overwrites the first the moment a request carries *both* `q`
  // and `cursor` — dropping the search filter on every page after the
  // first. Written against that spread-`OR` form, this test fails: page two
  // would include the unrelated product below instead of just the matching
  // one. Written against the `AND`-combined form actually shipped, it
  // passes.
  it('keeps the q filter applied on a second page fetched with a cursor', async () => {
    const gadgetAlpha = await createProduct(ctx.prisma, {
      slug: 'gadget-alpha',
      name: 'Gadget Alpha',
      createdAt: new Date('2026-02-04T00:00:00Z'),
    });
    const gadgetBeta = await createProduct(ctx.prisma, {
      slug: 'gadget-beta',
      name: 'Gadget Beta',
      createdAt: new Date('2026-02-03T00:00:00Z'),
    });
    // Sits between gadgetBeta and gadgetGamma in createdAt order, and does
    // NOT match q — if the search filter is dropped on the cursor request,
    // this is the product that leaks into page two.
    await createProduct(ctx.prisma, {
      slug: 'silent-case',
      name: 'Silent Case',
      createdAt: new Date('2026-02-02T00:00:00Z'),
    });
    const gadgetGamma = await createProduct(ctx.prisma, {
      slug: 'gadget-gamma',
      name: 'Gadget Gamma',
      createdAt: new Date('2026-02-01T00:00:00Z'),
    });

    const page1 = await ctx.request.get('/api/v1/products?q=gadget&limit=2').expect(200);
    const body1 = page1.body as ProductListBody;
    expect(body1.items.map((item) => item.id)).toEqual([gadgetAlpha.id, gadgetBeta.id]);
    expect(body1.nextCursor).not.toBeNull();

    const page2 = await ctx.request.get(`/api/v1/products?q=gadget&limit=2&cursor=${body1.nextCursor}`).expect(200);
    const body2 = page2.body as ProductListBody;
    expect(body2.items.map((item) => item.id)).toEqual([gadgetGamma.id]);
    expect(body2.nextCursor).toBeNull();
  });

  // Case 5 — the brief's worked example.
  it('reports the rating distribution for a product', async () => {
    const product = await createProduct(ctx.prisma, { slug: 'desk-lamp' });
    const users = await Promise.all([1, 2, 3, 4].map(() => createUser(ctx.prisma)));
    const ratings = [5, 5, 4, 1];
    await Promise.all(
      users.map((u, i) =>
        createReview(ctx.prisma, { productId: product.id, authorId: u.id, rating: ratings[i]!, status: 'APPROVED' }),
      ),
    );
    await createSummary(ctx.prisma, product.id, ratings);

    const res = await ctx.request.get('/api/v1/products/desk-lamp').expect(200);
    const body = res.body as ProductDetailDto;

    expect(body.summary).toMatchObject({
      reviewCount: 4,
      averageRating: 3.75,
      distribution: { '1': 1, '2': 0, '3': 0, '4': 1, '5': 2 },
    });
  });

  // Case 6.
  it('synthesises a zero summary for a product with no reviews, on both list and detail', async () => {
    await createProduct(ctx.prisma, { slug: 'no-reviews-yet' });

    const listRes = await ctx.request.get('/api/v1/products').expect(200);
    const listBody = listRes.body as ProductListBody;
    expect(listBody.items).toHaveLength(1);
    expect(listBody.items[0]!.summary).toEqual({
      productId: listBody.items[0]!.id,
      reviewCount: 0,
      averageRating: 0,
      distribution: ZERO_DISTRIBUTION,
    });

    const detailRes = await ctx.request.get('/api/v1/products/no-reviews-yet').expect(200);
    const detailBody = detailRes.body as ProductDetailDto;
    expect(detailBody.summary).toEqual({
      productId: detailBody.id,
      reviewCount: 0,
      averageRating: 0,
      distribution: ZERO_DISTRIBUTION,
    });
  });

  // Case 9.
  it('rejects limit=500 with 400', async () => {
    await ctx.request.get('/api/v1/products?limit=500').expect(400);
  });

  // Regression: an unvalidated `new Date(cursor.key)` on a malformed key
  // produces an Invalid Date, which reaches Prisma's serialiser and throws
  // `RangeError: Invalid time value` — not an `HttpException`, not a
  // Prisma error, so it falls through the global exception filter to a 500
  // on this public, unauthenticated endpoint. The identical bug was found
  // and fixed for the review listing (see review-listing.integration.test.ts's
  // "rejects a cursor with an unparseable date key"); this is the same
  // fix carried over to the product list.
  it('rejects a cursor with an unparseable date key with 400', async () => {
    const garbageCursor = encodeCursor('not-a-date', randomUUID(), 'products');

    await ctx.request.get(`/api/v1/products?cursor=${garbageCursor}`).expect(400);
  });

  // Regression: a validly-scoped cursor whose `id` isn't a UUID reaches a
  // `@db.Uuid` comparison and raises Prisma's unmapped P2023 (500) instead
  // of the 400 a malformed client-supplied cursor warrants.
  it('rejects a cursor whose id is not a UUID with 400', async () => {
    const garbageCursor = encodeCursor(new Date().toISOString(), 'not-a-uuid', 'products');

    await ctx.request.get(`/api/v1/products?cursor=${garbageCursor}`).expect(400);
  });
});

describe('GET /api/v1/products/:slug', () => {
  // Case 7.
  it('returns the detail payload including description', async () => {
    const product = await createProduct(ctx.prisma, {
      slug: 'ergonomic-mesh-chair',
      name: 'Ergonomic Mesh Chair',
      description: 'Breathable mesh back with adjustable lumbar support.',
      priceCents: 18900,
      currency: 'USD',
      imageUrl: 'https://example.com/images/ergonomic-mesh-chair.jpg',
    });

    const res = await ctx.request.get(`/api/v1/products/${product.slug}`).expect(200);

    expect(res.body).toMatchObject({
      id: product.id,
      slug: 'ergonomic-mesh-chair',
      name: 'Ergonomic Mesh Chair',
      description: 'Breathable mesh back with adjustable lumbar support.',
      priceCents: 18900,
      currency: 'USD',
      imageUrl: 'https://example.com/images/ergonomic-mesh-chair.jpg',
    });
  });

  // Case 8.
  it('returns 404 for an unknown slug', async () => {
    await ctx.request.get('/api/v1/products/unknown-slug').expect(404);
  });
});
