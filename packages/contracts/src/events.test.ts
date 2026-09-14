import { describe, expect, it } from 'vitest';
import { EVENT_TYPES, eventEnvelopeSchema, reviewSubmittedPayloadSchema } from './events.js';

const envelope = eventEnvelopeSchema(reviewSubmittedPayloadSchema);

const validEnvelope = {
  eventId: '0193a6f0-0000-7000-8000-000000000001',
  eventType: EVENT_TYPES.REVIEW_SUBMITTED,
  version: 1,
  occurredAt: '2026-09-13T10:00:00.000Z',
  aggregateType: 'review',
  aggregateId: '0193a6f0-0000-7000-8000-000000000002',
  payload: {
    reviewId: '0193a6f0-0000-7000-8000-000000000002',
    productId: '0193a6f0-0000-7000-8000-000000000003',
    authorId: '0193a6f0-0000-7000-8000-000000000004',
    rating: 5,
    title: 'Great',
    body: 'Long enough body text.',
    verifiedPurchase: true,
  },
} as const;

describe('eventEnvelopeSchema', () => {
  it('parses a submitted event and coerces occurredAt to a Date', () => {
    const parsed = envelope.parse(validEnvelope);
    expect(parsed.occurredAt).toBeInstanceOf(Date);
  });

  it('rejects an envelope whose version is unknown', () => {
    expect(() => envelope.parse({ ...validEnvelope, version: 2 })).toThrow();
  });

  // The outbox is meant to be the one gate that validates a payload before
  // it becomes a durable record — but a plain `z.object` silently strips
  // unknown keys instead of rejecting them, so a field added to a payload
  // literal without a matching schema update would vanish with no error and
  // no failing test. `.strict()` on both the envelope and the payload
  // schema is what turns that into a thrown validation error instead. This
  // test targets the payload; a sibling case immediately below targets the
  // envelope's own top-level keys.
  it('rejects a payload with an unknown field instead of silently dropping it', () => {
    const withExtraField = {
      ...validEnvelope,
      payload: { ...validEnvelope.payload, promoCode: 'DROPPED-SILENTLY' },
    };

    expect(() => envelope.parse(withExtraField)).toThrow();
  });

  it('rejects an envelope with an unknown top-level field', () => {
    expect(() => envelope.parse({ ...validEnvelope, extra: 'unexpected' })).toThrow();
  });
});
