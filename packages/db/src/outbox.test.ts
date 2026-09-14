import { EVENT_TYPES } from '@reviews/contracts';
import { describe, expect, it, vi } from 'vitest';
import { OutboxValidationError, writeOutboxEvent } from './outbox.js';

const AGGREGATE_ID = '0193a6f0-0000-7000-8000-000000000002';

const VALID_SUBMITTED_PAYLOAD = {
  reviewId: AGGREGATE_ID,
  productId: '0193a6f0-0000-7000-8000-000000000003',
  authorId: '0193a6f0-0000-7000-8000-000000000004',
  rating: 5,
  title: 'Great',
  body: 'Long enough body text.',
  verifiedPurchase: true,
};

/**
 * A minimal stand-in for `Prisma.TransactionClient` — only the one method
 * `writeOutboxEvent` actually calls. Typed `unknown` and cast at the call
 * site (not `any`) so the mock itself stays honest about what it is.
 */
function createTxMock() {
  const create = vi.fn().mockResolvedValue(undefined);
  return { outboxEvent: { create } };
}

describe('writeOutboxEvent', () => {
  it('writes exactly one outbox row for a valid event', async () => {
    const tx = createTxMock();

    await writeOutboxEvent(tx as never, {
      eventType: EVENT_TYPES.REVIEW_SUBMITTED,
      aggregateId: AGGREGATE_ID,
      payload: VALID_SUBMITTED_PAYLOAD,
    });

    expect(tx.outboxEvent.create).toHaveBeenCalledOnce();
    const call = tx.outboxEvent.create.mock.calls[0]?.[0] as {
      data: {
        aggregateType: string;
        aggregateId: string;
        eventType: string;
        occurredAt: Date;
        payload: { eventId: string; payload: unknown };
      };
    };
    expect(call.data.aggregateType).toBe('review');
    expect(call.data.aggregateId).toBe(AGGREGATE_ID);
    expect(call.data.eventType).toBe(EVENT_TYPES.REVIEW_SUBMITTED);
    expect(call.data.occurredAt).toBeInstanceOf(Date);
    // eventId is generated fresh as a UUIDv7 (version nibble '7').
    expect(call.data.payload.eventId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(call.data.payload.payload).toEqual(VALID_SUBMITTED_PAYLOAD);
  });

  it('generates a fresh UUIDv7 eventId on every call', async () => {
    const tx = createTxMock();

    await writeOutboxEvent(tx as never, {
      eventType: EVENT_TYPES.REVIEW_SUBMITTED,
      aggregateId: AGGREGATE_ID,
      payload: VALID_SUBMITTED_PAYLOAD,
    });
    await writeOutboxEvent(tx as never, {
      eventType: EVENT_TYPES.REVIEW_SUBMITTED,
      aggregateId: AGGREGATE_ID,
      payload: VALID_SUBMITTED_PAYLOAD,
    });

    const firstId = (tx.outboxEvent.create.mock.calls[0]?.[0] as { data: { payload: { eventId: string } } }).data
      .payload.eventId;
    const secondId = (tx.outboxEvent.create.mock.calls[1]?.[0] as { data: { payload: { eventId: string } } }).data
      .payload.eventId;
    expect(firstId).not.toBe(secondId);
  });

  it('rejects an unknown eventType before any insert is attempted', async () => {
    const tx = createTxMock();

    await expect(
      writeOutboxEvent(tx as never, {
        eventType: 'review.teleported' as never,
        aggregateId: AGGREGATE_ID,
        payload: VALID_SUBMITTED_PAYLOAD,
      }),
    ).rejects.toThrow(OutboxValidationError);

    expect(tx.outboxEvent.create).not.toHaveBeenCalled();
  });

  it('rejects a payload that fails the schema for its event type, before any insert is attempted', async () => {
    const tx = createTxMock();

    await expect(
      writeOutboxEvent(tx as never, {
        eventType: EVENT_TYPES.REVIEW_SUBMITTED,
        aggregateId: AGGREGATE_ID,
        // `rating` is out of range and `verifiedPurchase` is missing.
        payload: { ...VALID_SUBMITTED_PAYLOAD, rating: 99, verifiedPurchase: undefined },
      }),
    ).rejects.toThrow(OutboxValidationError);

    expect(tx.outboxEvent.create).not.toHaveBeenCalled();
  });

  it('accepts a moderation event using the shared moderated-payload schema', async () => {
    const tx = createTxMock();

    await writeOutboxEvent(tx as never, {
      eventType: EVENT_TYPES.REVIEW_APPROVED,
      aggregateId: AGGREGATE_ID,
      payload: {
        reviewId: AGGREGATE_ID,
        productId: '0193a6f0-0000-7000-8000-000000000003',
        status: 'APPROVED',
        moderationReason: null,
      },
    });

    expect(tx.outboxEvent.create).toHaveBeenCalledOnce();
  });
});
