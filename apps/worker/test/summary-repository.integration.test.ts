import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@reviews/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SummaryRepository } from '../src/aggregation/summary.repository.js';
import { createWorkerHarness, type WorkerHarness } from './harness.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function seedProduct(prisma: PrismaClient): Promise<{ id: string }> {
  return prisma.product.create({
    data: {
      slug: `summary-${randomUUID()}`,
      name: 'Summary test product',
      description: 'A product used to test concurrent recomputes.',
      priceCents: 2999,
      currency: 'USD',
    },
    select: { id: true },
  });
}

async function seedApprovedReview(prisma: PrismaClient, productId: string, rating: number): Promise<{ id: string }> {
  const author = await prisma.user.create({
    data: {
      email: `summary-author-${randomUUID()}@example.com`,
      displayName: 'Summary Test Author',
      passwordHash: 'not-a-real-hash',
      role: 'CUSTOMER',
    },
    select: { id: true },
  });
  return prisma.review.create({
    data: {
      productId,
      authorId: author.id,
      rating,
      title: 'A review',
      body: 'Body text long enough to be a real review.',
      status: 'APPROVED',
      verifiedPurchase: false,
    },
    select: { id: true },
  });
}

/**
 * Opens its own transaction and holds `pg_advisory_xact_lock(hashtext(key))`
 * until `release()` is called, standing in for "another `recompute` call is
 * currently in flight for this product". `ready` resolves once the lock is
 * actually held, so a caller can be sure a concurrent `recompute` attempting
 * the same lock will genuinely block rather than racing ahead of it.
 */
function holdAdvisoryLock(prisma: PrismaClient, key: string): { ready: Promise<void>; release: () => void; done: Promise<void> } {
  let markReady: () => void;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  let release!: () => void;
  const releaseSignal = new Promise<void>((resolve) => {
    release = resolve;
  });

  const done = prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
    markReady();
    await releaseSignal;
  });

  return { ready, release, done };
}

/**
 * I2: `recompute` is idempotent under *sequential* redelivery — every other
 * test in this suite (and `aggregation-consumer.integration.test.ts`)
 * exercises exactly that — but not under *concurrent* delivery, which
 * `PREFETCH = 10` (`consumer.base.ts`) makes routine. Without a per-product
 * lock serialising `recompute`, two overlapping calls can each take their
 * own aggregate snapshot of `reviews`, and Postgres does not re-evaluate an
 * `INSERT ... SELECT ... ON CONFLICT DO UPDATE`'s `SELECT` after the
 * conflict recheck — so whichever call's write lands *last* can overwrite
 * the row with values computed from an *older* snapshot than the one the
 * other call already committed, permanently undercounting the product
 * until some unrelated later event happens to correct it.
 *
 * This proves the fix's actual guarantee directly, rather than trying to
 * force two real concurrent `recompute` calls to land in exactly the wrong
 * order (indeterminate at the granularity a black-box test can control,
 * since `recompute` is one atomic statement): a `recompute` call that
 * starts while another is already "in flight" for the same product — stood
 * in for here by an externally held `pg_advisory_xact_lock` on the same
 * key `recompute` itself takes — must not take its snapshot until the
 * in-flight one has fully finished. `sleep(50)` after starting the call
 * under test gives a call with no such lock (the pre-fix behaviour) ample
 * time to run to completion, uncontended, before the second review is
 * inserted — so pre-fix this test reliably reproduces the stale read, not
 * just occasionally.
 */
describe('SummaryRepository.recompute concurrency', () => {
  let h: WorkerHarness;
  let repository: SummaryRepository;

  beforeAll(async () => {
    h = await createWorkerHarness();
    repository = new SummaryRepository();
  });

  afterEach(async () => {
    await h.prisma.productRatingSummary.deleteMany();
    await h.prisma.review.deleteMany();
    await h.prisma.user.deleteMany();
    await h.prisma.product.deleteMany();
  });

  afterAll(async () => {
    await h.close();
  });

  it('takes a fresh snapshot rather than a stale one when another recompute for the same product is in flight', async () => {
    const product = await seedProduct(h.prisma);
    await seedApprovedReview(h.prisma, product.id, 5);

    // Establish the baseline row via the ON CONFLICT DO UPDATE path (not
    // the first-ever INSERT path), matching the redelivery scenario the
    // bug actually occurs under.
    await h.prisma.$transaction((tx) => repository.recompute(tx, product.id));
    const baseline = await h.prisma.productRatingSummary.findUniqueOrThrow({ where: { productId: product.id } });
    expect(baseline.reviewCount).toBe(1);

    const lock = holdAdvisoryLock(h.prisma, product.id);
    await lock.ready;

    const callUnderTest = h.prisma.$transaction((tx) => repository.recompute(tx, product.id));

    // Give a call with no lock of its own (the pre-fix behaviour) ample
    // time to run to completion, uncontended, before the second review
    // exists — see the suite doc comment for why this makes the failure
    // deterministic rather than a race.
    await sleep(50);
    await seedApprovedReview(h.prisma, product.id, 3);

    lock.release();
    await lock.done;
    await callUnderTest;

    const summary = await h.prisma.productRatingSummary.findUniqueOrThrow({ where: { productId: product.id } });
    expect(summary.reviewCount).toBe(2);
    expect(Number(summary.averageRating)).toBe(4);
  });
});
