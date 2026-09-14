import { randomUUID } from 'node:crypto';
import { EVENT_TYPES, eventEnvelopeSchema, reviewSubmittedPayloadSchema } from '@reviews/contracts';
import type { PrismaClient, Review, ReviewStatus } from '@reviews/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { registerConsumer } from '../src/messaging/consumer.base.js';
import { dlqName, TOPOLOGY } from '../src/messaging/topology.js';
import { ModerationConsumer, type ReviewSubmittedEvent } from '../src/moderation/moderation.consumer.js';
import { ModerationRepository } from '../src/moderation/moderation.repository.js';
import { defaultPolicy } from '../src/moderation/policy.js';
import { createWorkerHarness, type WorkerHarness } from './harness.js';

const CLEAN_BODY = 'Used it daily for three months, no issues.';

async function seedUser(prisma: PrismaClient): Promise<{ id: string }> {
  return prisma.user.create({
    data: {
      email: `user-${randomUUID()}@example.com`,
      displayName: 'Test User',
      passwordHash: 'not-a-real-hash',
      role: 'CUSTOMER',
    },
    select: { id: true },
  });
}

async function seedProduct(prisma: PrismaClient): Promise<{ id: string }> {
  const slug = `product-${randomUUID()}`;
  return prisma.product.create({
    data: {
      slug,
      name: 'Test product',
      description: 'A product used for testing.',
      priceCents: 1999,
      currency: 'USD',
    },
    select: { id: true },
  });
}

interface SeedReviewOverrides {
  authorId?: string;
  status?: ReviewStatus;
  body?: string;
  verifiedPurchase?: boolean;
  moderationReason?: string | null;
}

/** Seeds a fresh product and (unless `authorId` is given) a fresh author, then one review on it. */
async function seedReview(prisma: PrismaClient, overrides: SeedReviewOverrides = {}): Promise<Review> {
  const authorId = overrides.authorId ?? (await seedUser(prisma)).id;
  const product = await seedProduct(prisma);

  return prisma.review.create({
    data: {
      productId: product.id,
      authorId,
      rating: 5,
      title: 'Great product',
      body: overrides.body ?? CLEAN_BODY,
      status: overrides.status ?? 'PENDING',
      verifiedPurchase: overrides.verifiedPurchase ?? false,
      moderationReason: overrides.moderationReason ?? null,
    },
  });
}

function seedPendingReview(prisma: PrismaClient, overrides: Omit<SeedReviewOverrides, 'status'> = {}): Promise<Review> {
  return seedReview(prisma, { ...overrides, status: 'PENDING' });
}

/**
 * Builds a schema-valid `review.submitted` envelope for `review`. Accepts a
 * partial shape — only `id` and `productId` are required — so the "review
 * no longer exists" case can build one for a row that was never actually
 * inserted.
 */
function submittedEventFor(review: {
  id: string;
  productId: string;
  authorId?: string;
  rating?: number;
  title?: string;
  body?: string;
  verifiedPurchase?: boolean;
}): ReviewSubmittedEvent {
  return eventEnvelopeSchema(reviewSubmittedPayloadSchema).parse({
    eventId: randomUUID(),
    eventType: EVENT_TYPES.REVIEW_SUBMITTED,
    version: 1,
    occurredAt: new Date(),
    aggregateType: 'review',
    aggregateId: review.id,
    payload: {
      reviewId: review.id,
      productId: review.productId,
      authorId: review.authorId ?? randomUUID(),
      rating: review.rating ?? 5,
      title: review.title ?? 'Great product',
      body: review.body ?? CLEAN_BODY,
      verifiedPurchase: review.verifiedPurchase ?? false,
    },
  });
}

describe('ModerationConsumer', () => {
  let h: WorkerHarness;
  let consumer: ModerationConsumer;

  beforeAll(async () => {
    h = await createWorkerHarness();
    const repository = new ModerationRepository(h.prisma, defaultPolicy);
    consumer = new ModerationConsumer(repository);

    // Registered once, for the whole suite: only the "dead-letters a
    // malformed message" case actually publishes onto the real queue, but
    // that means a live consumer needs to already be listening on it before
    // that test runs, exactly as it would be in the real worker.
    await registerConsumer(h.channel, TOPOLOGY.queues.moderation.name, (event: ReviewSubmittedEvent) => consumer.handle(event));
  });

  afterEach(async () => {
    await h.prisma.outboxEvent.deleteMany();
    await h.prisma.review.deleteMany();
    await h.prisma.user.deleteMany();
    await h.prisma.product.deleteMany();
    await h.purgeAll();
  });

  afterAll(async () => {
    await h.close();
  });

  it('approves a clean review and emits an approved event', async () => {
    const review = await seedPendingReview(h.prisma, { body: CLEAN_BODY });
    await consumer.handle(submittedEventFor(review));

    const after = await h.prisma.review.findUniqueOrThrow({ where: { id: review.id } });
    expect(after.status).toBe('APPROVED');
    expect(after.publishedAt).not.toBeNull();

    const events = await h.prisma.outboxEvent.findMany({ where: { aggregateId: review.id }, orderBy: { id: 'asc' } });
    expect(events.map((e) => e.eventType)).toEqual(['review.approved']);
  });

  it('rejects a review with banned language and records the reason', async () => {
    const review = await seedPendingReview(h.prisma, { body: 'This is complete garbage, you damn sellers.' });
    await consumer.handle(submittedEventFor(review));

    const after = await h.prisma.review.findUniqueOrThrow({ where: { id: review.id } });
    expect(after.status).toBe('REJECTED');
    expect(after.moderationReason).toMatch(/language/i);
    expect(after.publishedAt).toBeNull();

    const events = await h.prisma.outboxEvent.findMany({ where: { aggregateId: review.id }, orderBy: { id: 'asc' } });
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe('review.rejected');
  });

  it('flags a suspicious review without emitting a visibility event', async () => {
    const review = await seedPendingReview(h.prisma, {
      body: 'ABSOLUTELY TERRIBLE DO NOT BUY THIS EVER AGAIN',
      verifiedPurchase: false,
    });
    await consumer.handle(submittedEventFor(review));

    const after = await h.prisma.review.findUniqueOrThrow({ where: { id: review.id } });
    expect(after.status).toBe('FLAGGED');
    expect(after.publishedAt).toBeNull();

    const events = await h.prisma.outboxEvent.findMany({ where: { aggregateId: review.id } });
    expect(events.map((e) => e.eventType)).toEqual(['review.flagged']);
    expect(events.some((e) => e.eventType === EVENT_TYPES.REVIEW_APPROVED)).toBe(false);
  });

  it('is idempotent under redelivery', async () => {
    const review = await seedPendingReview(h.prisma, { body: CLEAN_BODY });
    const event = submittedEventFor(review);
    await consumer.handle(event);
    await consumer.handle(event);

    expect(await h.prisma.outboxEvent.count({ where: { aggregateId: review.id } })).toBe(1);
    expect((await h.prisma.review.findUniqueOrThrow({ where: { id: review.id } })).status).toBe('APPROVED');
  });

  it('does nothing when a moderator already decided', async () => {
    const review = await seedReview(h.prisma, { status: 'REJECTED', moderationReason: 'manual' });
    await consumer.handle(submittedEventFor(review));

    const after = await h.prisma.review.findUniqueOrThrow({ where: { id: review.id } });
    expect(after.status).toBe('REJECTED');
    expect(after.moderationReason).toBe('manual');
    expect(await h.prisma.outboxEvent.count({ where: { aggregateId: review.id } })).toBe(0);
  });

  it('does nothing when the review no longer exists', async () => {
    await expect(consumer.handle(submittedEventFor({ id: randomUUID(), productId: randomUUID() }))).resolves.not.toThrow();
  });

  it('passes the author previous bodies to the policy', async () => {
    const author = await seedUser(h.prisma);
    await seedReview(h.prisma, { authorId: author.id, status: 'APPROVED', body: CLEAN_BODY, verifiedPurchase: false });
    const review = await seedPendingReview(h.prisma, { authorId: author.id, body: CLEAN_BODY, verifiedPurchase: false });

    await consumer.handle(submittedEventFor(review));

    const after = await h.prisma.review.findUniqueOrThrow({ where: { id: review.id } });
    expect(after.status).toBe('FLAGGED');
    expect(after.moderationReason).toMatch(/duplicate/i);
  });

  it('dead-letters a message whose payload does not match the schema', async () => {
    await h.publishRaw(TOPOLOGY.queues.moderation.name, { garbage: true });

    const dead = await h.consumeOne(dlqName(TOPOLOGY.queues.moderation.name), 5_000);
    expect(dead).toBeDefined();
  });
});
