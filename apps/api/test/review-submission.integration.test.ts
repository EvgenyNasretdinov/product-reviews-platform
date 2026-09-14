import { randomUUID } from 'node:crypto';
import type { ReviewDto } from '@reviews/contracts';
import { describe, expect, it } from 'vitest';
import { createProduct, createUser } from './fixtures.js';
import { setupTestApp } from './harness.js';

// supertest's Response#body is typed `any`; narrow it through this shape
// once instead of sprinkling eslint-disable comments at each access.
interface ConflictBody {
  message: string;
  reviewId: string;
}

interface OutboxEnvelope {
  eventId: string;
  eventType: string;
  version: number;
  occurredAt: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
}

const ctx = setupTestApp();

const VALID_PAYLOAD = {
  rating: 5,
  title: 'Great lamp',
  body: 'Bright and well made, exceeded my expectations completely.',
};

function submit(productId: string, token: string, body: unknown = VALID_PAYLOAD) {
  return ctx.request
    .post(`/api/v1/products/${productId}/reviews`)
    .auth(token, { type: 'bearer' })
    .send(body as object);
}

describe('POST /api/v1/products/:productId/reviews', () => {
  // Case 1.
  it('accepts a valid submission from an authenticated customer as 202 Accepted, pending', async () => {
    const token = await ctx.loginAs('alice@example.com');
    const product = await createProduct(ctx.prisma);

    const res = await submit(product.id, token).expect(202);

    const body = res.body as ReviewDto;
    expect(body.status).toBe('PENDING');
    expect(body.publishedAt).toBeNull();
    expect(body.author.displayName).toBe('Alice Johnson');
    expect(body.productId).toBe(product.id);
    expect(body.rating).toBe(VALID_PAYLOAD.rating);
    expect(body.title).toBe(VALID_PAYLOAD.title);
    expect(body.body).toBe(VALID_PAYLOAD.body);
  });

  // Case 2. The point of this task: the review row and its event are
  // written in the same transaction. This only checks the happy path
  // writes exactly one row with the right shape — case 4 below is what
  // proves the transaction boundary is actually enforced.
  it('writes exactly one outbox row recording the submission', async () => {
    const token = await ctx.loginAs('alice@example.com');
    const alice = await ctx.prisma.user.findUniqueOrThrow({ where: { email: 'alice@example.com' } });
    const product = await createProduct(ctx.prisma);

    const res = await submit(product.id, token).expect(202);
    const reviewId = (res.body as ReviewDto).id;

    const rows = await ctx.prisma.outboxEvent.findMany();
    expect(rows).toHaveLength(1);

    const row = rows[0];
    expect(row).toBeDefined();
    expect(row?.eventType).toBe('review.submitted');
    expect(row?.aggregateId).toBe(reviewId);
    expect(row?.aggregateType).toBe('review');
    expect(row?.publishedAt).toBeNull();

    const envelope = row?.payload as OutboxEnvelope;
    expect(envelope.payload).toMatchObject({
      reviewId,
      productId: product.id,
      authorId: alice.id,
      rating: VALID_PAYLOAD.rating,
      title: VALID_PAYLOAD.title,
      body: VALID_PAYLOAD.body,
      verifiedPurchase: false,
    });
  });

  // Case 3.
  it('rejects a second submission by the same author for the same product with 409 and the existing review id', async () => {
    const token = await ctx.loginAs('alice@example.com');
    const product = await createProduct(ctx.prisma);

    const first = await submit(product.id, token).expect(202);
    const second = await submit(product.id, token).expect(409);

    const conflictBody = second.body as ConflictBody;
    expect(conflictBody.reviewId).toBe((first.body as ReviewDto).id);
  });

  // Case 4 — the point of the whole task. If the event were emitted
  // outside the transaction wrapping the review insert, this would still
  // pass with a naive "emit after commit" implementation but fail once the
  // duplicate insert rolls back after an event was already queued; the
  // real risk this guards is an implementation that writes the outbox row
  // unconditionally before attempting the insert. Written exactly as
  // specified in the task brief.
  it('writes no outbox event when the submission conflicts', async () => {
    const token = await ctx.loginAs('alice@example.com');
    const product = await createProduct(ctx.prisma);
    const payload = { rating: 5, title: 'Great lamp', body: 'Bright and well made.' };

    await ctx.request.post(`/api/v1/products/${product.id}/reviews`).auth(token, { type: 'bearer' }).send(payload).expect(202);
    await ctx.request.post(`/api/v1/products/${product.id}/reviews`).auth(token, { type: 'bearer' }).send(payload).expect(409);

    expect(await ctx.prisma.outboxEvent.count()).toBe(1);
  });

  // Case 5.
  it('marks verifiedPurchase true only for an author with a matching purchase row', async () => {
    const buyer = await createUser(ctx.prisma, { email: 'buyer@example.com' });
    await createUser(ctx.prisma, { email: 'nonbuyer@example.com' });
    const product = await createProduct(ctx.prisma);
    await ctx.prisma.purchase.create({ data: { userId: buyer.id, productId: product.id } });

    const buyerToken = await ctx.loginAs('buyer@example.com');
    const nonBuyerToken = await ctx.loginAs('nonbuyer@example.com');

    const buyerRes = await submit(product.id, buyerToken, {
      rating: 5,
      title: 'Exactly as described',
      body: 'Really happy with this purchase, will buy again soon.',
    }).expect(202);
    const nonBuyerRes = await submit(product.id, nonBuyerToken, {
      rating: 3,
      title: 'It is fine I guess',
      body: 'Does the job but nothing particularly special honestly.',
    }).expect(202);

    expect((buyerRes.body as ReviewDto).verifiedPurchase).toBe(true);
    expect((nonBuyerRes.body as ReviewDto).verifiedPurchase).toBe(false);
  });

  // Case 6.
  it('rejects an unauthenticated submission with 401', async () => {
    const product = await createProduct(ctx.prisma);

    await ctx.request.post(`/api/v1/products/${product.id}/reviews`).send(VALID_PAYLOAD).expect(401);
  });

  // Case 7.
  it('rejects a rating outside 1..5 with 400', async () => {
    const token = await ctx.loginAs('alice@example.com');
    const product = await createProduct(ctx.prisma);

    await submit(product.id, token, { ...VALID_PAYLOAD, rating: 6 }).expect(400);
  });

  it('rejects a body shorter than the minimum length with 400', async () => {
    const token = await ctx.loginAs('alice@example.com');
    const product = await createProduct(ctx.prisma);

    await submit(product.id, token, { ...VALID_PAYLOAD, body: 'short' }).expect(400);
  });

  // Case 8.
  it('returns 404 when the product does not exist', async () => {
    const token = await ctx.loginAs('alice@example.com');

    await submit(randomUUID(), token).expect(404);
  });

  // Case 8, race safety: the not-found check must not race a concurrent
  // insert. Two submissions for the same missing product should both 404,
  // never one 404 and one 500 from an FK violation.
  it('answers 404 for concurrent submissions against the same missing product', async () => {
    const token = await ctx.loginAs('alice@example.com');
    const missingProductId = randomUUID();

    const [first, second] = await Promise.all([submit(missingProductId, token), submit(missingProductId, token)]);

    expect(first.status).toBe(404);
    expect(second.status).toBe(404);
  });
});
