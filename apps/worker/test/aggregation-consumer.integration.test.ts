import { randomUUID } from 'node:crypto';
import {
  cacheKeys,
  EVENT_TYPES,
  eventEnvelopeSchema,
  reviewModeratedPayloadSchema,
  reviewUnpublishedPayloadSchema,
} from '@reviews/contracts';
import type { PrismaClient, ReviewStatus } from '@reviews/db';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AggregationConsumer, type AggregationEvent } from '../src/aggregation/aggregation.consumer.js';
import { SummaryRepository } from '../src/aggregation/summary.repository.js';
import { createWorkerHarness, type WorkerHarness } from './harness.js';

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

async function seedProduct(prisma: PrismaClient): Promise<{ id: string; slug: string }> {
  const slug = `product-${randomUUID()}`;
  return prisma.product.create({
    data: {
      slug,
      name: 'Test product',
      description: 'A product used for testing.',
      priceCents: 1999,
      currency: 'USD',
    },
    select: { id: true, slug: true },
  });
}

interface ReviewSpec {
  rating: number;
  status: ReviewStatus;
}

/** Seeds one review per spec on `productId`, each with its own author — `reviews` is unique on (productId, authorId). */
async function seedReviews(prisma: PrismaClient, productId: string, specs: ReviewSpec[]): Promise<{ id: string }[]> {
  const created: { id: string }[] = [];
  for (const spec of specs) {
    const author = await seedUser(prisma);
    created.push(
      await prisma.review.create({
        data: {
          productId,
          authorId: author.id,
          rating: spec.rating,
          title: 'A review',
          body: 'Body text long enough to be a real review.',
          status: spec.status,
          verifiedPurchase: false,
        },
        select: { id: true },
      }),
    );
  }
  return created;
}

/** A schema-valid `review.approved` envelope for `productId`. */
function approvedEventFor(productId: string, reviewId: string = randomUUID()): AggregationEvent {
  return eventEnvelopeSchema(reviewModeratedPayloadSchema).parse({
    eventId: randomUUID(),
    eventType: EVENT_TYPES.REVIEW_APPROVED,
    version: 1,
    occurredAt: new Date(),
    aggregateType: 'review',
    aggregateId: reviewId,
    payload: {
      reviewId,
      productId,
      status: 'APPROVED',
      moderationReason: null,
      decidedBy: 'AUTOMATIC',
      moderatorId: null,
    },
  });
}

/** A schema-valid `review.unpublished` envelope for `productId`. */
function unpublishedEventFor(productId: string, reviewId: string = randomUUID()): AggregationEvent {
  return eventEnvelopeSchema(reviewUnpublishedPayloadSchema).parse({
    eventId: randomUUID(),
    eventType: EVENT_TYPES.REVIEW_UNPUBLISHED,
    version: 1,
    occurredAt: new Date(),
    aggregateType: 'review',
    aggregateId: reviewId,
    payload: { reviewId, productId },
  });
}

describe('AggregationConsumer', () => {
  let h: WorkerHarness;
  let consumer: AggregationConsumer;

  beforeAll(async () => {
    h = await createWorkerHarness();
    const summaryRepository = new SummaryRepository();
    consumer = new AggregationConsumer(h.prisma, summaryRepository, h.cache);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await h.prisma.productRatingSummary.deleteMany();
    await h.prisma.review.deleteMany();
    await h.prisma.user.deleteMany();
    await h.prisma.product.deleteMany();
  });

  afterAll(async () => {
    await h.close();
  });

  it('computes the summary from approved reviews only', async () => {
    const product = await seedProduct(h.prisma);
    await seedReviews(h.prisma, product.id, [
      { rating: 5, status: 'APPROVED' },
      { rating: 5, status: 'APPROVED' },
      { rating: 4, status: 'APPROVED' },
      { rating: 1, status: 'APPROVED' },
      { rating: 1, status: 'PENDING' },
      { rating: 1, status: 'REJECTED' },
    ]);

    await consumer.handle(approvedEventFor(product.id));

    const summary = await h.prisma.productRatingSummary.findUniqueOrThrow({ where: { productId: product.id } });
    expect(summary.reviewCount).toBe(4);
    expect(Number(summary.averageRating)).toBe(3.75);
    expect([summary.count1, summary.count2, summary.count3, summary.count4, summary.count5]).toEqual([1, 0, 0, 1, 2]);
  });

  it('produces the same summary no matter how many times the event is delivered', async () => {
    const product = await seedProduct(h.prisma);
    await seedReviews(h.prisma, product.id, [{ rating: 5, status: 'APPROVED' }]);
    const event = approvedEventFor(product.id);

    await consumer.handle(event);
    const first = await h.prisma.productRatingSummary.findUniqueOrThrow({ where: { productId: product.id } });
    await consumer.handle(event);
    await consumer.handle(event);
    const third = await h.prisma.productRatingSummary.findUniqueOrThrow({ where: { productId: product.id } });

    expect({ ...third, updatedAt: null }).toEqual({ ...first, updatedAt: null });
  });

  it('drops the summary to zero when the last approved review is unpublished', async () => {
    const product = await seedProduct(h.prisma);
    const [review] = await seedReviews(h.prisma, product.id, [{ rating: 5, status: 'APPROVED' }]);
    if (!review) throw new Error('seedReviews did not return a review');

    await consumer.handle(approvedEventFor(product.id, review.id));
    const withReview = await h.prisma.productRatingSummary.findUniqueOrThrow({ where: { productId: product.id } });
    expect(withReview.reviewCount).toBe(1);

    // The review no longer counts as approved and visible — moderation's
    // own withdrawal path is out of scope here; deleting the row is enough
    // to put `reviews` in the state review.unpublished promises: nothing
    // left that satisfies `status = 'APPROVED'` for this product.
    await h.prisma.review.delete({ where: { id: review.id } });
    await consumer.handle(unpublishedEventFor(product.id, review.id));

    const summary = await h.prisma.productRatingSummary.findUniqueOrThrow({ where: { productId: product.id } });
    expect(summary.reviewCount).toBe(0);
    expect(Number(summary.averageRating)).toBe(0);
    expect(summary.ratingSum).toBe(0);
    expect([summary.count1, summary.count2, summary.count3, summary.count4, summary.count5]).toEqual([0, 0, 0, 0, 0]);
  });

  it('creates the summary row when none exists yet', async () => {
    const product = await seedProduct(h.prisma);
    await seedReviews(h.prisma, product.id, [{ rating: 3, status: 'APPROVED' }]);

    await expect(h.prisma.productRatingSummary.findUnique({ where: { productId: product.id } })).resolves.toBeNull();

    await consumer.handle(approvedEventFor(product.id));

    const summary = await h.prisma.productRatingSummary.findUniqueOrThrow({ where: { productId: product.id } });
    expect(summary.reviewCount).toBe(1);
  });

  it('invalidates exactly the cache keys the API reads', async () => {
    const product = await seedProduct(h.prisma);
    await seedReviews(h.prisma, product.id, [{ rating: 4, status: 'APPROVED' }]);

    await h.cache.set(cacheKeys.productDetail(product.slug), { stale: true }, 60);
    await h.cache.set(cacheKeys.productSummary(product.id), { stale: true }, 60);
    await h.cache.set(cacheKeys.reviewListFirstPage(product.id, 'helpful'), { stale: true }, 30);
    await h.cache.set('unrelated:key', { keep: true }, 60);

    await consumer.handle(approvedEventFor(product.id));

    expect(await h.cache.get(cacheKeys.productDetail(product.slug))).toBeNull();
    expect(await h.cache.get(cacheKeys.productSummary(product.id))).toBeNull();
    expect(await h.cache.get(cacheKeys.reviewListFirstPage(product.id, 'helpful'))).toBeNull();
    expect(await h.cache.get('unrelated:key')).not.toBeNull();
  });

  it('still updates the database when cache invalidation fails', async () => {
    const product = await seedProduct(h.prisma);
    await seedReviews(h.prisma, product.id, [{ rating: 2, status: 'APPROVED' }]);
    vi.spyOn(h.cache, 'del').mockRejectedValueOnce(new Error('redis down'));

    await expect(consumer.handle(approvedEventFor(product.id))).resolves.not.toThrow();

    const summary = await h.prisma.productRatingSummary.findUniqueOrThrow({ where: { productId: product.id } });
    expect(summary.reviewCount).toBe(1);
  });
});
