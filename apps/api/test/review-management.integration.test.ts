import type { Product, Review, ReviewStatus, User } from '@reviews/db';
import type { ReviewDto } from '@reviews/contracts';
import { describe, expect, it } from 'vitest';
import { createProduct, createReview, createUser, type CreateReviewOverrides } from './fixtures.js';
import { setupTestApp } from './harness.js';

// supertest's Response#body is typed `any`; narrow it through this shape
// once instead of sprinkling eslint-disable comments at each access.
interface MyReviewsBody {
  items: ReviewDto[];
  nextCursor: string | null;
}

const ctx = setupTestApp();

interface SeededReview {
  user: User;
  product: Product;
  review: Review;
}

/** Finds `email`'s user row, or creates a plain CUSTOMER if it doesn't exist yet. */
async function ensureUser(email: string): Promise<User> {
  const existing = await ctx.prisma.user.findUnique({ where: { email } });
  return existing ?? createUser(ctx.prisma, { email });
}

/**
 * Creates a fresh product and one review on it authored by `email` (creating
 * that user first if `ctx.loginAs(email)` hasn't already). `overrides`
 * follows `createReview`'s own shape, minus `productId`/`authorId`, which
 * this helper always fills in itself.
 */
async function seedReviewBy(
  email: string,
  overrides: Omit<CreateReviewOverrides, 'productId' | 'authorId'> = {},
): Promise<SeededReview> {
  const user = await ensureUser(email);
  const product = await createProduct(ctx.prisma);
  const review = await createReview(ctx.prisma, { productId: product.id, authorId: user.id, ...overrides });
  return { user, product, review };
}

/** As {@link seedReviewBy}, defaulted to an already-published `APPROVED` review. */
async function seedApprovedReviewBy(
  email: string,
  overrides: Omit<CreateReviewOverrides, 'productId' | 'authorId'> = {},
): Promise<SeededReview> {
  return seedReviewBy(email, { status: 'APPROVED', publishedAt: new Date(), ...overrides });
}

function patchReview(reviewId: string, token: string, body: unknown) {
  return ctx.request.patch(`/api/v1/reviews/${reviewId}`).auth(token, { type: 'bearer' }).send(body as object);
}

function deleteReview(reviewId: string, token: string) {
  return ctx.request.delete(`/api/v1/reviews/${reviewId}`).auth(token, { type: 'bearer' });
}

function getMine(token: string) {
  return ctx.request.get('/api/v1/me/reviews').auth(token, { type: 'bearer' });
}

describe('PATCH /api/v1/reviews/:id', () => {
  // Case 1.
  it('updates the body of a pending review, leaving it pending, with one new review.submitted event', async () => {
    const token = await ctx.loginAs('author1@example.com');
    const { review } = await seedReviewBy('author1@example.com', { status: 'PENDING' });

    const res = await patchReview(review.id, token, {
      body: 'Updated after using it for another month, still solid.',
    }).expect(200);

    const body = res.body as ReviewDto;
    expect(body.status).toBe('PENDING');
    expect(body.body).toBe('Updated after using it for another month, still solid.');

    const events = await ctx.prisma.outboxEvent.findMany({ where: { aggregateId: review.id }, orderBy: { id: 'asc' } });
    expect(events.map((e) => e.eventType)).toEqual(['review.submitted']);
  });

  // Case 2. The subtle one: event ordering is load-bearing.
  it('unpublishes and resubmits when an approved review is edited', async () => {
    const token = await ctx.loginAs('alice@example.com');
    const { review } = await seedApprovedReviewBy('alice@example.com');

    await patchReview(review.id, token, { body: 'Rewritten after three more months of use.' }).expect(200);

    const events = await ctx.prisma.outboxEvent.findMany({
      where: { aggregateId: review.id },
      orderBy: { id: 'asc' },
    });
    expect(events.map((e) => e.eventType)).toEqual(['review.unpublished', 'review.submitted']);

    const updated = await ctx.prisma.review.findUniqueOrThrow({ where: { id: review.id } });
    expect(updated.status).toBe('PENDING');
    expect(updated.publishedAt).toBeNull();
  });

  // Case 3.
  it("rejects a different customer patching someone else's review with 403", async () => {
    const { review } = await seedApprovedReviewBy('owner3@example.com');
    const otherToken = await ctx.loginAs('other3@example.com');

    await patchReview(review.id, otherToken, { body: 'Trying to rewrite a review that is not mine.' }).expect(403);
  });

  // Case 4. Moderators decide, they do not rewrite.
  it("rejects a moderator patching someone else's review with 403", async () => {
    const { review } = await seedApprovedReviewBy('owner4@example.com');
    const modToken = await ctx.loginAs('mod@example.com');

    await patchReview(review.id, modToken, { body: 'A moderator should not be able to rewrite this.' }).expect(403);
  });
});

describe('DELETE /api/v1/reviews/:id', () => {
  // Case 5.
  it('lets the author delete their review, cascading votes and emitting one review.unpublished event', async () => {
    const token = await ctx.loginAs('author5@example.com');
    const { review } = await seedApprovedReviewBy('author5@example.com');
    const voter = await createUser(ctx.prisma, { email: 'voter5@example.com' });
    await ctx.prisma.reviewVote.create({ data: { reviewId: review.id, userId: voter.id, value: 'HELPFUL' } });

    await deleteReview(review.id, token).expect(204);

    const found = await ctx.prisma.review.findUnique({ where: { id: review.id } });
    expect(found).toBeNull();

    const votes = await ctx.prisma.reviewVote.findMany({ where: { reviewId: review.id } });
    expect(votes).toHaveLength(0);

    const events = await ctx.prisma.outboxEvent.findMany({ where: { aggregateId: review.id }, orderBy: { id: 'asc' } });
    expect(events.map((e) => e.eventType)).toEqual(['review.unpublished']);
  });

  // Case 6.
  it("lets a moderator delete another user's review", async () => {
    const { review } = await seedApprovedReviewBy('owner6@example.com');
    const modToken = await ctx.loginAs('mod@example.com');

    await deleteReview(review.id, modToken).expect(204);

    const found = await ctx.prisma.review.findUnique({ where: { id: review.id } });
    expect(found).toBeNull();
  });

  // Case 3-for-delete: a different customer may not delete someone else's review.
  it("rejects a different customer deleting someone else's review with 403", async () => {
    const { review } = await seedApprovedReviewBy('owner3d@example.com');
    const otherToken = await ctx.loginAs('other3d@example.com');

    await deleteReview(review.id, otherToken).expect(403);

    const found = await ctx.prisma.review.findUnique({ where: { id: review.id } });
    expect(found).not.toBeNull();
  });

  // Case 7. Deletion frees the UNIQUE(product_id, author_id) slot.
  it('lets the author submit a fresh review for the same product after deleting the old one', async () => {
    const token = await ctx.loginAs('author7@example.com');
    const { review, product } = await seedApprovedReviewBy('author7@example.com');

    await deleteReview(review.id, token).expect(204);

    await ctx.request
      .post(`/api/v1/products/${product.id}/reviews`)
      .auth(token, { type: 'bearer' })
      .send({
        rating: 4,
        title: 'Second attempt at this review',
        body: 'Submitting a brand new review now that the old one is gone.',
      })
      .expect(202);
  });
});

describe('GET /api/v1/me/reviews', () => {
  // Case 8.
  it('returns the caller review in every status, with moderationReason populated for rejected ones', async () => {
    const token = await ctx.loginAs('author8@example.com');
    const { review: pending } = await seedReviewBy('author8@example.com', { status: 'PENDING' as ReviewStatus });
    const { review: rejected } = await seedReviewBy('author8@example.com', {
      status: 'REJECTED' as ReviewStatus,
      moderationReason: 'Contains promotional links.',
    });
    const { review: approved } = await seedApprovedReviewBy('author8@example.com');

    const res = await getMine(token).expect(200);
    const items = (res.body as MyReviewsBody).items;

    const byId = new Map(items.map((r) => [r.id, r]));
    expect(byId.has(pending.id)).toBe(true);
    expect(byId.has(rejected.id)).toBe(true);
    expect(byId.has(approved.id)).toBe(true);

    expect(byId.get(pending.id)?.status).toBe('PENDING');
    expect(byId.get(rejected.id)?.status).toBe('REJECTED');
    expect(byId.get(rejected.id)?.moderationReason).toBe('Contains promotional links.');
  });

  // Case 9.
  it("never returns another user's review", async () => {
    const token = await ctx.loginAs('author9a@example.com');
    const { review: mine } = await seedReviewBy('author9a@example.com', { status: 'PENDING' as ReviewStatus });
    const { review: theirs } = await seedReviewBy('author9b@example.com', { status: 'PENDING' as ReviewStatus });

    const res = await getMine(token).expect(200);
    const items = (res.body as MyReviewsBody).items;
    const ids = items.map((r) => r.id);

    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(theirs.id);
  });

  // Regression: previously returned every review the caller had ever
  // written as a bare, unbounded array, with no `take` and no cursor.
  it('paginates with a cursor, covering every review exactly once across pages', async () => {
    const token = await ctx.loginAs('author10@example.com');
    const reviews: Review[] = [];
    for (let i = 0; i < 5; i += 1) {
      const { review } = await seedReviewBy('author10@example.com', { status: 'PENDING' as ReviewStatus });
      reviews.push(review);
    }

    const collected: string[] = [];
    let cursor: string | null = null;
    do {
      const url = `/api/v1/me/reviews?limit=2${cursor ? `&cursor=${cursor}` : ''}`;
      const res: { body: MyReviewsBody } = await ctx.request
        .get(url)
        .auth(token, { type: 'bearer' })
        .expect(200);
      collected.push(...res.body.items.map((r) => r.id));
      cursor = res.body.nextCursor;
    } while (cursor);

    expect(collected.sort()).toEqual(reviews.map((r) => r.id).sort());
    expect(new Set(collected).size).toBe(reviews.length);
  });

  it('rejects limit=0 and limit=101 with 400', async () => {
    const token = await ctx.loginAs('author11@example.com');

    await ctx.request.get('/api/v1/me/reviews?limit=0').auth(token, { type: 'bearer' }).expect(400);
    await ctx.request.get('/api/v1/me/reviews?limit=101').auth(token, { type: 'bearer' }).expect(400);
  });
});
