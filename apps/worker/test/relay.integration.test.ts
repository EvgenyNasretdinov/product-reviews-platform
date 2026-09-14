import { randomUUID } from 'node:crypto';
import { EVENT_TYPES, type EventType } from '@reviews/contracts';
import type { OutboxEvent, Prisma, PrismaClient } from '@reviews/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventPublisher, type EventEnvelope } from '../src/messaging/event.publisher.js';
import { TOPOLOGY } from '../src/messaging/topology.js';
import { OutboxRelayService, type OutboxRelayConfig } from '../src/relay/outbox-relay.service.js';
import { OutboxRepository } from '../src/relay/outbox.repository.js';
import { createWorkerHarness, type WorkerHarness } from './harness.js';

const CONFIG: OutboxRelayConfig = { batchSize: 20, maxAttempts: 5, pollIntervalMs: 500 };

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
 * A schema-valid business payload for `eventType`, keyed off the same
 * per-type shapes `packages/contracts/src/events.ts` defines (`.strict()`
 * schemas — an envelope with the wrong shape for its own `eventType`
 * fails `OutboxRepository`'s validation, same as it would in production).
 * `insertOutboxRow` needs this instead of one fixed shape because some
 * tests below insert more than one event type for the same aggregate.
 */
function buildPayload(eventType: EventType, reviewId: string): Prisma.InputJsonObject {
  switch (eventType) {
    case EVENT_TYPES.REVIEW_UNPUBLISHED:
      return { reviewId, productId: randomUUID() };
    case EVENT_TYPES.REVIEW_APPROVED:
    case EVENT_TYPES.REVIEW_REJECTED:
    case EVENT_TYPES.REVIEW_FLAGGED:
      return {
        reviewId,
        productId: randomUUID(),
        status: eventType === EVENT_TYPES.REVIEW_APPROVED ? 'APPROVED' : eventType === EVENT_TYPES.REVIEW_REJECTED ? 'REJECTED' : 'FLAGGED',
        moderationReason: null,
        decidedBy: 'MODERATOR',
        moderatorId: randomUUID(),
      };
    case EVENT_TYPES.REVIEW_SUBMITTED:
    default:
      return {
        reviewId,
        productId: randomUUID(),
        authorId: randomUUID(),
        rating: 5,
        title: 'Great product',
        body: 'Solid build quality and easy to use every day.',
        verifiedPurchase: true,
      };
  }
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
  overrides: { attempts?: number; aggregateId?: string } = {},
): Promise<OutboxEvent> {
  const created = await prisma.outboxEvent.create({
    data: {
      aggregateType: 'review',
      aggregateId: overrides.aggregateId ?? randomUUID(),
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
    payload: buildPayload(eventType, idToReviewId(created.id)),
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

  it('marks the surviving rows published when one row in the batch fails to publish', async () => {
    // This is the exact scenario the separate-transaction failure path
    // exists for: a batch of several rows where exactly one fails to
    // publish must not roll back the others. Every other failure/parking
    // case in this suite seeds a single row, so without this test the
    // `continue`-on-publish-failure branch in `runOnce` is exercised but
    // never actually proven to isolate a bad row from good ones sharing
    // its batch.
    const good1 = await insertOutboxRow(h.prisma, EVENT_TYPES.REVIEW_SUBMITTED);
    const bad = await insertOutboxRow(h.prisma, EVENT_TYPES.REVIEW_SUBMITTED);
    const good2 = await insertOutboxRow(h.prisma, EVENT_TYPES.REVIEW_SUBMITTED);

    const realPublish = publisher.publish.bind(publisher);
    vi.spyOn(publisher, 'publish').mockImplementation(async (envelope: EventEnvelope) => {
      if (envelope.aggregateId === bad.aggregateId) throw new Error('boom for the middle row');
      await realPublish(envelope);
    });

    const result = await relay.runOnce();
    expect(result).toEqual({ published: 2, failed: 1 });

    const [after1, afterBad, after2] = await Promise.all([
      h.prisma.outboxEvent.findUniqueOrThrow({ where: { id: good1.id } }),
      h.prisma.outboxEvent.findUniqueOrThrow({ where: { id: bad.id } }),
      h.prisma.outboxEvent.findUniqueOrThrow({ where: { id: good2.id } }),
    ]);
    expect(after1.publishedAt).not.toBeNull();
    expect(after2.publishedAt).not.toBeNull();
    expect(afterBad.publishedAt).toBeNull();
    expect(afterBad.attempts).toBe(1);
    expect(afterBad.lastError).toMatch(/boom for the middle row/);

    // and the two survivors actually reached the broker, not just the DB
    const received = await h.consumeMany(TOPOLOGY.queues.moderation.name, 2, 5_000);
    expect(received).toHaveLength(2);
  });

  it('publishes review.unpublished before review.submitted for the same aggregate', async () => {
    // The concrete scenario `ORDER BY id` exists for: editing an approved
    // review emits `review.unpublished` then `review.submitted` for the
    // same aggregate, and a consumer that saw them in the opposite order
    // would recompute a rating from text that is back on display. The two
    // event types route to different queues (aggregation vs. moderation —
    // see topology.ts), so queue delivery order can't observe this;
    // spying on `publisher.publish`'s call order can, since `runOnce`
    // calls it once per claimed row in claim order.
    const aggregateId = randomUUID();
    const unpublishedRow = await insertOutboxRow(h.prisma, EVENT_TYPES.REVIEW_UNPUBLISHED, { aggregateId });
    const submittedRow = await insertOutboxRow(h.prisma, EVENT_TYPES.REVIEW_SUBMITTED, { aggregateId });
    expect(unpublishedRow.id < submittedRow.id).toBe(true);

    const publishOrder: string[] = [];
    const realPublish = publisher.publish.bind(publisher);
    vi.spyOn(publisher, 'publish').mockImplementation(async (envelope: EventEnvelope) => {
      if (envelope.aggregateId === aggregateId) publishOrder.push(envelope.eventType);
      await realPublish(envelope);
    });

    await relay.runOnce();

    expect(publishOrder).toEqual([EVENT_TYPES.REVIEW_UNPUBLISHED, EVENT_TYPES.REVIEW_SUBMITTED]);
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

  /**
   * Task 6's `stopAndDrain` exists specifically because `stop()` alone
   * only nominally stops the relay — it clears the interval but does not
   * wait for a batch already inside `runOnce()` to finish. This proves
   * the drain is real: with a publish deliberately slow, `stopAndDrain()`
   * must not resolve until that publish (and the mark-published write
   * after it) has actually completed, and the row must end up published,
   * not abandoned mid-batch.
   */
  it('stopAndDrain waits for a batch already in flight to finish, not just stops the interval', async () => {
    const row = await insertOutboxRow(h.prisma, EVENT_TYPES.REVIEW_SUBMITTED);

    const PUBLISH_DELAY_MS = 250;
    const slowPublisher: EventPublisher = {
      publish: async (envelope) => {
        await new Promise((resolve) => setTimeout(resolve, PUBLISH_DELAY_MS));
        await publisher.publish(envelope);
      },
    } as EventPublisher;

    const slowRelay = new OutboxRelayService(h.prisma, slowPublisher, repository, { ...CONFIG, pollIntervalMs: 20 });
    slowRelay.start();

    // Give the interval one tick to fire and enter the slow publish before
    // asking it to stop — otherwise stopAndDrain could race ahead of the
    // first tick ever starting, and would trivially "pass" without ever
    // exercising the drain at all.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const beforeDrain = Date.now();
    await slowRelay.stopAndDrain();
    const drainedAfterMs = Date.now() - beforeDrain;

    expect(drainedAfterMs).toBeGreaterThanOrEqual(PUBLISH_DELAY_MS - 50);
    const after = await h.prisma.outboxEvent.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.publishedAt).not.toBeNull();
  });
});
