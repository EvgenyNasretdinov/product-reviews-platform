import { randomUUID } from 'node:crypto';
import {
  EVENT_TYPES,
  eventEnvelopeSchema,
  reviewModeratedPayloadSchema,
  reviewSubmittedPayloadSchema,
} from '@reviews/contracts';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { assertTopology, TOPOLOGY } from '../src/messaging/topology.js';
import type { EventEnvelope } from '../src/messaging/event.publisher.js';
import { createWorkerHarness, type WorkerHarness } from './harness.js';

// One representative, schema-valid payload per event type this suite
// exercises. Built from the real contracts schemas (via `buildEnvelope`
// below) rather than typed by hand, so a fixture that has drifted from
// `@reviews/contracts` fails the test that uses it instead of silently
// publishing something the real system would never produce.
const SAMPLE_PAYLOADS = {
  [EVENT_TYPES.REVIEW_SUBMITTED]: {
    schema: reviewSubmittedPayloadSchema,
    payload: {
      reviewId: randomUUID(),
      productId: randomUUID(),
      authorId: randomUUID(),
      rating: 5,
      title: 'Great product',
      body: 'Works exactly as described.',
      verifiedPurchase: true,
    },
  },
  [EVENT_TYPES.REVIEW_APPROVED]: {
    schema: reviewModeratedPayloadSchema,
    payload: {
      reviewId: randomUUID(),
      productId: randomUUID(),
      status: 'APPROVED' as const,
      moderationReason: null,
      decidedBy: 'MODERATOR' as const,
      moderatorId: randomUUID(),
    },
  },
} as const;

function buildEnvelope(eventType: keyof typeof SAMPLE_PAYLOADS): EventEnvelope {
  const { schema, payload } = SAMPLE_PAYLOADS[eventType];
  return eventEnvelopeSchema(schema).parse({
    eventId: randomUUID(),
    eventType,
    version: 1,
    occurredAt: new Date(),
    aggregateType: 'review',
    aggregateId: randomUUID(),
    payload,
  });
}

describe('EventPublisher', () => {
  let h: WorkerHarness;

  beforeAll(async () => {
    h = await createWorkerHarness();
  });

  afterEach(async () => {
    await h.purgeAll();
  });

  afterAll(async () => {
    await h.close();
  });

  it('publishes an event that lands on the bound queue', async () => {
    const envelope = buildEnvelope(EVENT_TYPES.REVIEW_SUBMITTED);
    await h.publish(envelope);

    const message = await h.consumeOne(TOPOLOGY.queues.moderation.name, 5_000);
    const parsed = JSON.parse(message.content.toString()) as { eventId: string };
    expect(parsed.eventId).toBe(envelope.eventId);
  });

  it('does not deliver an approved event to the moderation queue', async () => {
    await h.publish(buildEnvelope(EVENT_TYPES.REVIEW_APPROVED));

    await expect(h.consumeOne(TOPOLOGY.queues.moderation.name, 1_000)).rejects.toThrow(/timeout/);
  });

  it('marks messages persistent so a broker restart does not lose them', async () => {
    await h.publish(buildEnvelope(EVENT_TYPES.REVIEW_SUBMITTED));

    const message = await h.consumeOne(TOPOLOGY.queues.moderation.name, 5_000);
    expect(message.properties.deliveryMode).toBe(2);
  });

  it('declares topology idempotently', async () => {
    await expect(assertTopology(h.channel)).resolves.not.toThrow();
    await expect(assertTopology(h.channel)).resolves.not.toThrow();
  });
});

