import type { ProductDetailDto, RatingSummaryDto } from '@reviews/contracts';
import { describe, expect, it } from 'vitest';
import { createProduct, createReview, createSummary, createUser } from './fixtures.js';
import { setupTestApp } from './harness.js';

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
