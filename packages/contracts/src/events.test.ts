import { describe, expect, it } from 'vitest';
import { EVENT_TYPES, eventEnvelopeSchema, reviewSubmittedPayloadSchema } from './events.js';

const envelope = eventEnvelopeSchema(reviewSubmittedPayloadSchema);

describe('eventEnvelopeSchema', () => {
  it('parses a submitted event and coerces occurredAt to a Date', () => {
    const parsed = envelope.parse({
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
    });
    expect(parsed.occurredAt).toBeInstanceOf(Date);
  });

  it('rejects an envelope whose version is unknown', () => {
    expect(() => envelope.parse({ version: 2 })).toThrow();
  });
});
