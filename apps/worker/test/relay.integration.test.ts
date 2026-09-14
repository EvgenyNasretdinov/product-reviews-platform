import { randomUUID } from 'node:crypto';
import { EVENT_TYPES, type EventType } from '@reviews/contracts';
import type { OutboxEvent, PrismaClient } from '@reviews/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventPublisher } from '../src/messaging/event.publisher.js';
import { TOPOLOGY } from '../src/messaging/topology.js';
import { OutboxRelayService, type OutboxRelayConfig } from '../src/relay/outbox-relay.service.js';
import { OutboxRepository } from '../src/relay/outbox.repository.js';
import { createWorkerHarness, type WorkerHarness } from './harness.js';

const CONFIG: OutboxRelayConfig = { batchSize: 50, maxAttempts: 5, pollIntervalMs: 500 };

/**
 * Maps an outbox row's own (autoincrement) id to a deterministic,
 * schema-valid `reviewId` UUID, so the id-ordering test can assert
 * "messages arrived in the order their rows were inserted" by comparing
 * `payload.reviewId` back against the ids `insertOutboxRow` returned —
 * without needing the relay or the broker to round-trip the row id
 * itself anywhere.
 */
function idToReviewId(id: bigint): string {
  const hex = id.toString(16).padStart(12, '0').slice(-12);
  return `00000000-0000-4000-8000-${hex}`;
}

/**
 * Inserts one outbox row whose `payload` column is the full envelope
 * shape `writeOutboxEvent` (`@reviews/db`) itself writes — verified
 * against that module during Task 1's review — with a `reviewId`
 * derived from the row's own id via {@link idToReviewId}. Row creation
 * is two statements (create, then update) because the envelope's
 * `reviewId` is only knowable once Postgres has assigned the identity
 * column's value.
 */
async function insertOutboxRow(
  prisma: PrismaClient,
  eventType: EventType,
  overrides: { attempts?: number } = {},
): Promise<OutboxEvent> {
  const created = await prisma.outboxEvent.create({
    data: {
      aggregateType: 'review',
      aggregateId: randomUUID(),
      eventType,
      payload: {},
      attempts: overrides.attempts ?? 0,
    },
  });

  const envelope = {
    eventId: randomUUID(),
    eventType,
    version: 1,
    occurredAt: new Date().toISOString(),
    aggregateType: 'review',
    aggregateId: created.aggregateId,
    payload: {
      reviewId: idToReviewId(created.id),
      productId: randomUUID(),
      authorId: randomUUID(),
      rating: 5,
      title: 'Great product',
      body: 'Solid build quality and easy to use every day.',
      verifiedPurchase: true,
    },
  };

  return prisma.outboxEvent.update({
    where: { id: created.id },
    data: { payload: envelope },
  });
}

describe('OutboxRelayService.runOnce', () => {
  let h: WorkerHarness;
  let publisher: EventPublisher;
  let repository: OutboxRepository;
  let relay: OutboxRelayService;

  beforeAll(async () => {
    h = await createWorkerHarness();
  });

  beforeEach(() => {
    publisher = new EventPublisher({ getChannel: () => h.channel });
    repository = new OutboxRepository(h.prisma);
    relay = new OutboxRelayService(h.prisma, publisher, repository, CONFIG);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await h.prisma.outboxEvent.deleteMany();
    await h.purgeAll();
  });

  afterAll(async () => {
    await h.close();
  });

  it('publishes an unpublished row and marks it published', async () => {
    const row = await insertOutboxRow(h.prisma, EVENT_TYPES.REVIEW_SUBMITTED);
    const result = await relay.runOnce();

    expect(result).toEqual({ published: 1, failed: 0 });
    const after = await h.prisma.outboxEvent.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.publishedAt).not.toBeNull();
    await expect(h.consumeOne(TOPOLOGY.queues.moderation.name, 5_000)).resolves.toBeDefined();
  });

  it('publishes in id order', async () => {
    const ids: bigint[] = [];
    for (let i = 0; i < 5; i++) ids.push((await insertOutboxRow(h.prisma, EVENT_TYPES.REVIEW_SUBMITTED)).id);

    await relay.runOnce();

    const received = await h.consumeMany(TOPOLOGY.queues.moderation.name, 5);
    const reviewIds = received.map((m) => (JSON.parse(m.content.toString()) as { payload: { reviewId: string } }).payload.reviewId);
    expect(reviewIds).toEqual(ids.map(idToReviewId));
  });

  it('does not republish a row it already published', async () => {
    await insertOutboxRow(h.prisma, EVENT_TYPES.REVIEW_SUBMITTED);
    await relay.runOnce();

    expect(await relay.runOnce()).toEqual({ published: 0, failed: 0 });
  });

  it('two concurrent relays never publish the same row twice', async () => {
    for (let i = 0; i < 20; i++) await insertOutboxRow(h.prisma, EVENT_TYPES.REVIEW_SUBMITTED);

    const publisherA = new EventPublisher({ getChannel: () => h.channel });
    const publisherB = new EventPublisher({ getChannel: () => h.channel });
    const repositoryA = new OutboxRepository(h.prisma);
    const repositoryB = new OutboxRepository(h.prisma);
    const relayA = new OutboxRelayService(h.prisma, publisherA, repositoryA, CONFIG);
    const relayB = new OutboxRelayService(h.prisma, publisherB, repositoryB, CONFIG);

    // Proof that the two `runOnce()` calls genuinely overlapped in time
    // rather than one finishing before the other started: record each
    // call's own start/end wall-clock time and, after both resolve,
    // assert each one's window began before the other's ended. If the
    // harness accidentally serialised them (e.g. by awaiting one before
    // starting the other), this assertion — not just the published counts
    // below — would fail.
    let aStart = 0;
    let aEnd = 0;
    let bStart = 0;
    let bEnd = 0;
    const runA = (async () => {
      aStart = performance.now();
      const result = await relayA.runOnce();
      aEnd = performance.now();
      return result;
    })();
    const runB = (async () => {
      bStart = performance.now();
      const result = await relayB.runOnce();
      bEnd = performance.now();
      return result;
    })();

    const [a, b] = await Promise.all([runA, runB]);

    expect(aStart).toBeLessThan(bEnd);
    expect(bStart).toBeLessThan(aEnd);

    expect(a.published + b.published).toBe(20);
    const received = await h.consumeMany(TOPOLOGY.queues.moderation.name, 20, 5_000);
    expect(new Set(received.map((m) => m.properties.messageId as string)).size).toBe(20);
  });

  it('records the error and increments attempts when publishing fails', async () => {
    const row = await insertOutboxRow(h.prisma, EVENT_TYPES.REVIEW_SUBMITTED);
    vi.spyOn(publisher, 'publish').mockRejectedValueOnce(new Error('broker down'));

    expect(await relay.runOnce()).toEqual({ published: 0, failed: 1 });
    const after = await h.prisma.outboxEvent.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.publishedAt).toBeNull();
    expect(after.attempts).toBe(1);
    expect(after.lastError).toMatch(/broker down/);
  });

  it('parks a row after the maximum number of attempts', async () => {
    const row = await insertOutboxRow(h.prisma, EVENT_TYPES.REVIEW_SUBMITTED, { attempts: 5 });
    vi.spyOn(publisher, 'publish').mockRejectedValue(new Error('still down'));

    expect(await relay.runOnce()).toEqual({ published: 0, failed: 0 });
    expect((await h.prisma.outboxEvent.findUniqueOrThrow({ where: { id: row.id } })).attempts).toBe(5);
  });

  it('leaves the row unpublished if the transaction fails after publishing', async () => {
    // publish succeeds, the mark-published UPDATE throws
    const row = await insertOutboxRow(h.prisma, EVENT_TYPES.REVIEW_SUBMITTED);
    vi.spyOn(repository, 'markPublished').mockRejectedValueOnce(new Error('db gone'));

    await relay.runOnce().catch(() => undefined);
    expect((await h.prisma.outboxEvent.findUniqueOrThrow({ where: { id: row.id } })).publishedAt).toBeNull();

    // the next run republishes: at-least-once, and the consumer must tolerate it
    await relay.runOnce();
    const received = await h.consumeMany(TOPOLOGY.queues.moderation.name, 2, 5_000);
    expect(received).toHaveLength(2);
  });
});
