import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { execSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrismaClient } from '../src/index.js';
import type { PrismaClient } from '../src/index.js';

let container: StartedPostgreSqlContainer;
let prisma: PrismaClient;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine').start();
  const url = container.getConnectionUri();
  execSync('pnpm prisma migrate deploy', { env: { ...process.env, DATABASE_URL: url }, stdio: 'inherit' });
  prisma = createPrismaClient(url);
}, 120_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await container?.stop();
});

async function seedProductAndUser() {
  const user = await prisma.user.create({
    data: { email: `u${Date.now()}@example.com`, displayName: 'U', passwordHash: 'x', role: 'CUSTOMER' },
  });
  const product = await prisma.product.create({
    data: { slug: `p-${Date.now()}`, name: 'P', description: 'd', priceCents: 100, currency: 'EUR' },
  });
  return { user, product };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('reviews table', () => {
  it('allows only one review per author per product', async () => {
    const { user, product } = await seedProductAndUser();
    const base = { productId: product.id, authorId: user.id, rating: 5, title: 't', body: 'b' };
    await prisma.review.create({ data: base });
    await expect(prisma.review.create({ data: base })).rejects.toThrow(/Unique constraint/);
  });

  it('rejects a rating outside 1..5', async () => {
    const { user, product } = await seedProductAndUser();
    await expect(
      prisma.review.create({ data: { productId: product.id, authorId: user.id, rating: 6, title: 't', body: 'b' } }),
    ).rejects.toThrow();
  });

  it('deletes votes when the review is deleted', async () => {
    const { user, product } = await seedProductAndUser();
    const review = await prisma.review.create({
      data: { productId: product.id, authorId: user.id, rating: 4, title: 't', body: 'b' },
    });
    await prisma.reviewVote.create({ data: { reviewId: review.id, userId: user.id, value: 'HELPFUL' } });
    await prisma.review.delete({ where: { id: review.id } });
    expect(await prisma.reviewVote.count({ where: { reviewId: review.id } })).toBe(0);
  });

  it('issues time-ordered UUIDv7 identifiers', async () => {
    const { product: first } = await seedProductAndUser();
    // UUIDv7 only guarantees ordering across millisecond boundaries, not
    // within one. Two inserts issued back to back can land in the same
    // millisecond and order either way, so this delay makes the assertion
    // actually test time ordering instead of flaking on a fast machine.
    await delay(2);
    const { product: second } = await seedProductAndUser();
    expect(first.id < second.id).toBe(true);
    expect(first.id[14]).toBe('7'); // version nibble
  });
});

describe('outbox table', () => {
  it('uses an identity column rather than a serial default', async () => {
    const rows = await prisma.$queryRaw<Array<{ is_identity: string; column_default: string | null }>>`
      SELECT is_identity, column_default
      FROM information_schema.columns
      WHERE table_name = 'outbox' AND column_name = 'id'
    `;
    expect(rows[0]?.is_identity).toBe('YES');
    expect(rows[0]?.column_default).toBeNull();
  });

  it('refuses an explicitly supplied id', async () => {
    await expect(
      prisma.$executeRaw`INSERT INTO outbox (id, aggregate_type, aggregate_id, event_type, payload)
                         VALUES (1, 'review', gen_random_uuid(), 'review.submitted', '{}'::jsonb)`,
    ).rejects.toThrow();
  });

  it('assigns increasing ids', async () => {
    const { product } = await seedProductAndUser();
    const a = await prisma.outboxEvent.create({
      data: { aggregateType: 'review', aggregateId: product.id, eventType: 'review.submitted', payload: {} },
    });
    const b = await prisma.outboxEvent.create({
      data: { aggregateType: 'review', aggregateId: product.id, eventType: 'review.submitted', payload: {} },
    });
    expect(b.id > a.id).toBe(true);
  });
});
