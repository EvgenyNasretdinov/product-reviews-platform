import type { Review, ReviewStatus } from '@reviews/db';
import type { ReviewDto } from '@reviews/contracts';
import { describe, expect, it } from 'vitest';
import { createProduct, createReview, createUser } from './fixtures.js';
import { setupTestApp } from './harness.js';

// supertest's Response#body is typed `any`; narrow it through this shape
// once instead of sprinkling eslint-disable comments at each access.
interface ModerationQueueBody {
  items: ReviewDto[];
  nextCursor: string | null;
}

const ctx = setupTestApp();

/** Creates a fresh product and one review on it in `status`, authored by a fresh user. */
async function seedReview(
  status: ReviewStatus,
  overrides: { title?: string; body?: string; authorDisplayName?: string } = {},
): Promise<{ review: Review; productId: string; authorId: string }> {
  const author = await createUser(ctx.prisma, { displayName: overrides.authorDisplayName ?? 'Queue Author' });
  const product = await createProduct(ctx.prisma);
  const review = await createReview(ctx.prisma, {
    productId: product.id,
    authorId: author.id,
    status,
    title: overrides.title,
    body: overrides.body,
  });
  return { review, productId: product.id, authorId: author.id };
}

function listQueue(token: string, query: Record<string, string> = {}) {
  const qs = new URLSearchParams(query).toString();
  return ctx.request
    .get(`/api/v1/moderation/reviews${qs ? `?${qs}` : ''}`)
    .auth(token, { type: 'bearer' });
}

function decide(reviewId: string, token: string, body: unknown) {
  return ctx.request
    .post(`/api/v1/moderation/reviews/${reviewId}`)
    .auth(token, { type: 'bearer' })
    .send(body as object);
}

describe('GET /api/v1/moderation/reviews', () => {
  // Case 1 (queue half).
  it('rejects a CUSTOMER with 403', async () => {
    const token = await ctx.loginAs('customer1@example.com');
    await listQueue(token).expect(403);
  });

  // Case 2 (queue half).
  it('rejects a request with no token with 401', async () => {
    await ctx.request.get('/api/v1/moderation/reviews').expect(401);
  });

  // Case 3.
  it('shows FLAGGED reviews by default, newest first', async () => {
    const modToken = await ctx.loginAs('mod@example.com');
    const { review: older } = await seedReview('FLAGGED');
    const { review: newer } = await seedReview('FLAGGED', {});
    await ctx.prisma.review.update({ where: { id: older.id }, data: { createdAt: new Date(Date.now() - 60_000) } });
    await seedReview('PENDING');
    await seedReview('APPROVED');

    const res = await listQueue(modToken).expect(200);
    const body = res.body as ModerationQueueBody;
    const ids = body.items.map((r) => r.id);

    expect(ids).toContain(older.id);
    expect(ids).toContain(newer.id);
    expect(ids.indexOf(newer.id)).toBeLessThan(ids.indexOf(older.id));
    expect(body.items.every((r) => r.status === 'FLAGGED')).toBe(true);
  });

  // Case 4.
  it('status=PENDING filters to only PENDING reviews', async () => {
    const modToken = await ctx.loginAs('mod@example.com');
    const { review: pending } = await seedReview('PENDING');
    await seedReview('FLAGGED');

    const res = await listQueue(modToken, { status: 'PENDING' }).expect(200);
    const body = res.body as ModerationQueueBody;

    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.id).toBe(pending.id);
    expect(body.items[0]?.status).toBe('PENDING');
  });

  // Case 9.
  it('includes the full review body and the author display name', async () => {
    const modToken = await ctx.loginAs('mod@example.com');
    const { review } = await seedReview('FLAGGED', {
      title: 'Detailed review title',
      body: 'A long, detailed review body a moderator needs to read in full to judge.',
      authorDisplayName: 'Judgeable Author',
    });

    const res = await listQueue(modToken).expect(200);
    const body = res.body as ModerationQueueBody;
    const item = body.items.find((r) => r.id === review.id);

    expect(item?.title).toBe('Detailed review title');
    expect(item?.body).toBe('A long, detailed review body a moderator needs to read in full to judge.');
    expect(item?.author.displayName).toBe('Judgeable Author');
  });
});

describe('POST /api/v1/moderation/reviews/:id', () => {
  // Case 1 (decision half).
  it('rejects a CUSTOMER with 403', async () => {
    const token = await ctx.loginAs('customer1b@example.com');
    const { review } = await seedReview('FLAGGED');

    await decide(review.id, token, { decision: 'APPROVED', reason: null }).expect(403);
  });

  // Case 2 (decision half).
  it('rejects a request with no token with 401', async () => {
    const { review } = await seedReview('FLAGGED');

    await ctx.request
      .post(`/api/v1/moderation/reviews/${review.id}`)
      .send({ decision: 'APPROVED', reason: null })
      .expect(401);
  });

  // Case 5.
  it('approving a FLAGGED review publishes it and writes one review.approved event', async () => {
    const modToken = await ctx.loginAs('mod@example.com');
    const { review } = await seedReview('FLAGGED');

    const res = await decide(review.id, modToken, { decision: 'APPROVED', reason: null }).expect(200);
    const body = res.body as ReviewDto;

    expect(body.status).toBe('APPROVED');
    expect(body.publishedAt).not.toBeNull();

    const updated = await ctx.prisma.review.findUniqueOrThrow({ where: { id: review.id } });
    expect(updated.status).toBe('APPROVED');
    expect(updated.publishedAt).not.toBeNull();

    const events = await ctx.prisma.outboxEvent.findMany({ where: { aggregateId: review.id } });
    expect(events.map((e) => e.eventType)).toEqual(['review.approved']);
  });

  // Case 6.
  it('rejecting without a reason returns 400', async () => {
    const modToken = await ctx.loginAs('mod@example.com');
    const { review } = await seedReview('FLAGGED');

    await decide(review.id, modToken, { decision: 'REJECTED', reason: null }).expect(400);

    const untouched = await ctx.prisma.review.findUniqueOrThrow({ where: { id: review.id } });
    expect(untouched.status).toBe('FLAGGED');
  });

  // Case 7.
  it('rejecting with a reason stores it and writes one review.rejected event, publishedAt stays null', async () => {
    const modToken = await ctx.loginAs('mod@example.com');
    const { review } = await seedReview('FLAGGED');

    const res = await decide(review.id, modToken, {
      decision: 'REJECTED',
      reason: 'Contains promotional links.',
    }).expect(200);
    const body = res.body as ReviewDto;

    expect(body.status).toBe('REJECTED');
    expect(body.moderationReason).toBe('Contains promotional links.');
    expect(body.publishedAt).toBeNull();

    const updated = await ctx.prisma.review.findUniqueOrThrow({ where: { id: review.id } });
    expect(updated.status).toBe('REJECTED');
    expect(updated.moderationReason).toBe('Contains promotional links.');
    expect(updated.publishedAt).toBeNull();

    const events = await ctx.prisma.outboxEvent.findMany({ where: { aggregateId: review.id } });
    expect(events.map((e) => e.eventType)).toEqual(['review.rejected']);
  });

  // Case 8.
  it('approving an already-APPROVED review returns 409 and writes no outbox row', async () => {
    const modToken = await ctx.loginAs('mod@example.com');
    const { review } = await seedReview('APPROVED');

    await decide(review.id, modToken, { decision: 'APPROVED', reason: null }).expect(409);

    const events = await ctx.prisma.outboxEvent.findMany({ where: { aggregateId: review.id } });
    expect(events).toHaveLength(0);
  });
});
