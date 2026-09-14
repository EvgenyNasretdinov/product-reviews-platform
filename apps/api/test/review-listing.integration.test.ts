import type { Product, Review } from '@reviews/db';
import type { ReviewDto } from '@reviews/contracts';
import { describe, expect, it } from 'vitest';
import { createProduct, createReview, createUser } from './fixtures.js';
import { setupTestApp } from './harness.js';
import type { PrismaService } from '../src/common/prisma/prisma.service.js';

// supertest's Response#body is typed `any`; narrow it through this shape
// once instead of sprinkling eslint-disable comments at each access.
interface ReviewListBody {
  items: ReviewDto[];
  nextCursor: string | null;
}

const ctx = setupTestApp();

/**
 * Seeds one APPROVED review per entry in `overrides`, each by a distinct
 * fresh author (the `UNIQUE(product_id, author_id)` constraint on reviews
 * forbids more than one review per author per product). Returns the created
 * rows in seed order — callers compare ids against the response, not order,
 * since the whole point of most of these tests is that the *server* decides
 * the order.
 */
async function seedApprovedReviews(
  prisma: PrismaService,
  productId: string,
  overrides: Array<{ rating?: number; helpfulCount?: number; createdAt?: Date }>,
): Promise<Review[]> {
  const rows: Review[] = [];
  for (const overrideEntry of overrides) {
    const author = await createUser(prisma);
    const row = await createReview(prisma, {
      productId,
      authorId: author.id,
      status: 'APPROVED',
      ...overrideEntry,
    });
    rows.push(row);
  }
  return rows;
}

async function createProductWithAuthor(prisma: PrismaService): Promise<{ product: Product; authorId: string }> {
  const product = await createProduct(prisma);
  const author = await createUser(prisma);
  return { product, authorId: author.id };
}

describe('GET /api/v1/products/:productId/reviews', () => {
  // Case 1.
  it('returns only APPROVED reviews', async () => {
    const { product } = await createProductWithAuthor(ctx.prisma);
    const pending = await createUser(ctx.prisma);
    const approved = await createUser(ctx.prisma);
    const rejected = await createUser(ctx.prisma);
    const flagged = await createUser(ctx.prisma);

    await createReview(ctx.prisma, { productId: product.id, authorId: pending.id, status: 'PENDING' });
    const approvedReview = await createReview(ctx.prisma, { productId: product.id, authorId: approved.id, status: 'APPROVED' });
    await createReview(ctx.prisma, { productId: product.id, authorId: rejected.id, status: 'REJECTED' });
    await createReview(ctx.prisma, { productId: product.id, authorId: flagged.id, status: 'FLAGGED' });

    const res = await ctx.request.get(`/api/v1/products/${product.id}/reviews`).expect(200);

    const body = res.body as ReviewListBody;
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.id).toBe(approvedReview.id);
  });

  // Deferred from Task 10's case 9: a PENDING review the same author just
  // submitted must not show up in the public list, now that a listing
  // endpoint exists to check it against.
  it('excludes a PENDING review from the public list', async () => {
    const { product, authorId } = await createProductWithAuthor(ctx.prisma);
    await createReview(ctx.prisma, { productId: product.id, authorId, status: 'PENDING' });

    const res = await ctx.request.get(`/api/v1/products/${product.id}/reviews`).expect(200);

    const body = res.body as ReviewListBody;
    expect(body.items).toHaveLength(0);
  });

  // Case 2.
  it('sort=newest orders by createdAt DESC, tie-broken by id DESC', async () => {
    const { product } = await createProductWithAuthor(ctx.prisma);
    const seeded = await seedApprovedReviews(ctx.prisma, product.id, [
      { createdAt: new Date('2026-01-01T00:00:00Z') },
      { createdAt: new Date('2026-01-03T00:00:00Z') },
      { createdAt: new Date('2026-01-02T00:00:00Z') },
    ]);
    const [oldest, newest, middle] = seeded;

    const res = await ctx.request.get(`/api/v1/products/${product.id}/reviews?sort=newest`).expect(200);

    const body = res.body as ReviewListBody;
    expect(body.items.map((item) => item.id)).toEqual([newest?.id, middle?.id, oldest?.id]);
  });

  // Case 3.
  it('sort=helpful orders by helpfulCount DESC, tie-broken by createdAt DESC then id DESC', async () => {
    const { product } = await createProductWithAuthor(ctx.prisma);
    const seeded = await seedApprovedReviews(ctx.prisma, product.id, [
      { helpfulCount: 5, createdAt: new Date('2026-01-01T00:00:00Z') },
      { helpfulCount: 1, createdAt: new Date('2026-01-01T00:00:00Z') },
      { helpfulCount: 5, createdAt: new Date('2026-01-02T00:00:00Z') },
    ]);
    const [tiedOlder, leastHelpful, tiedNewer] = seeded;

    const res = await ctx.request.get(`/api/v1/products/${product.id}/reviews?sort=helpful`).expect(200);

    const body = res.body as ReviewListBody;
    // Both tiedOlder and tiedNewer share helpfulCount 5; createdAt breaks
    // the tie (tiedNewer is more recent), then leastHelpful trails last.
    expect(body.items.map((item) => item.id)).toEqual([tiedNewer?.id, tiedOlder?.id, leastHelpful?.id]);
  });

  // Case 4.
  it('sort=rating_desc and sort=rating_asc order by rating with the same tie-breakers', async () => {
    const { product } = await createProductWithAuthor(ctx.prisma);
    const seeded = await seedApprovedReviews(ctx.prisma, product.id, [{ rating: 2 }, { rating: 5 }, { rating: 3 }]);
    const [two, five, three] = seeded;

    const descRes = await ctx.request.get(`/api/v1/products/${product.id}/reviews?sort=rating_desc`).expect(200);
    const descBody = descRes.body as ReviewListBody;
    expect(descBody.items.map((item) => item.id)).toEqual([five?.id, three?.id, two?.id]);

    const ascRes = await ctx.request.get(`/api/v1/products/${product.id}/reviews?sort=rating_asc`).expect(200);
    const ascBody = ascRes.body as ReviewListBody;
    expect(ascBody.items.map((item) => item.id)).toEqual([two?.id, three?.id, five?.id]);
  });

  // Case 5.
  it('rating=4 returns only 4-star reviews', async () => {
    const { product } = await createProductWithAuthor(ctx.prisma);
    const seeded = await seedApprovedReviews(ctx.prisma, product.id, [{ rating: 4 }, { rating: 5 }, { rating: 4 }, { rating: 1 }]);
    const fourStarIds = [seeded[0]?.id, seeded[2]?.id].sort();

    const res = await ctx.request.get(`/api/v1/products/${product.id}/reviews?rating=4`).expect(200);

    const body = res.body as ReviewListBody;
    expect(body.items.map((item) => item.id).sort()).toEqual(fourStarIds);
  });

  // Case 6 — the important one. Three of the five reviews share
  // helpfulCount: 3, which is exactly the condition under which a cursor
  // built from the sort key alone loses or repeats rows.
  it('pages through helpful-sorted reviews without duplicates or gaps', async () => {
    const { product } = await createProductWithAuthor(ctx.prisma);
    const seeded = await seedApprovedReviews(ctx.prisma, product.id, [
      { helpfulCount: 3 },
      { helpfulCount: 3 },
      { helpfulCount: 3 },
      { helpfulCount: 1 },
      { helpfulCount: 0 },
    ]);

    const collected: string[] = [];
    let cursor: string | null = null;
    do {
      const url = `/api/v1/products/${product.id}/reviews?sort=helpful&limit=2${cursor ? `&cursor=${cursor}` : ''}`;
      const res: { body: ReviewListBody } = await ctx.request.get(url).expect(200);
      collected.push(...res.body.items.map((r) => r.id));
      cursor = res.body.nextCursor;
    } while (cursor);

    expect(collected.sort()).toEqual(seeded.map((r) => r.id).sort());
    expect(new Set(collected).size).toBe(seeded.length);
  });

  // Case 7. The scope check: a cursor minted under one sort must not be
  // silently replayed against another. This must fail loudly as a 400, not
  // crash as a 500 from a failed downstream parse.
  it('rejects a cursor from sort=newest replayed against sort=helpful with 400', async () => {
    const { product } = await createProductWithAuthor(ctx.prisma);
    await seedApprovedReviews(ctx.prisma, product.id, [{}, {}, {}]);

    const newestRes = await ctx.request
      .get(`/api/v1/products/${product.id}/reviews?sort=newest&limit=1`)
      .expect(200);
    const newestBody = newestRes.body as ReviewListBody;
    expect(newestBody.nextCursor).not.toBeNull();

    await ctx.request
      .get(`/api/v1/products/${product.id}/reviews?sort=helpful&limit=1&cursor=${newestBody.nextCursor}`)
      .expect(400);
  });

  // Case 8.
  it('rejects limit=0 and limit=101 with 400', async () => {
    const { product } = await createProductWithAuthor(ctx.prisma);

    await ctx.request.get(`/api/v1/products/${product.id}/reviews?limit=0`).expect(400);
    await ctx.request.get(`/api/v1/products/${product.id}/reviews?limit=101`).expect(400);
  });

  // Case 9. moderationReason is a moderator's private note; the public
  // list must never leak it, even when the underlying row carries one (an
  // APPROVED review can still have a leftover value from an earlier
  // moderation pass).
  it('never includes moderationReason for another user in the response', async () => {
    const product = await createProduct(ctx.prisma);
    const author = await createUser(ctx.prisma);
    await createReview(ctx.prisma, {
      productId: product.id,
      authorId: author.id,
      status: 'APPROVED',
      moderationReason: 'Previously flagged for review, now cleared.',
    });

    const res = await ctx.request.get(`/api/v1/products/${product.id}/reviews`).expect(200);

    const body = res.body as ReviewListBody;
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.moderationReason).toBeNull();
  });
});
