import {
  EVENT_TYPES,
  eventEnvelopeSchema,
  eventTypeSchema,
  reviewModeratedPayloadSchema,
  reviewSubmittedPayloadSchema,
  reviewUnpublishedPayloadSchema,
  type EventType,
} from '@reviews/contracts';
import { Injectable } from '@nestjs/common';
import type { Prisma, PrismaClient } from '@reviews/db';
import type { ZodTypeAny } from 'zod';
import type { EventEnvelope } from '../messaging/event.publisher.js';

/**
 * Maps every domain event type to the Zod schema its business payload must
 * satisfy. Duplicated from (rather than imported out of) `@reviews/db`'s
 * `writeOutboxEvent` — that map is a module-private constant there — but
 * kept in lockstep with it deliberately: both exist so that a payload
 * validated on the way in (`writeOutboxEvent`) is validated the same way
 * on the way out (here), and `packages/contracts` remains the one place
 * that actually defines the shapes both sides check against.
 */
const PAYLOAD_SCHEMAS: Record<EventType, ZodTypeAny> = {
  [EVENT_TYPES.REVIEW_SUBMITTED]: reviewSubmittedPayloadSchema,
  [EVENT_TYPES.REVIEW_APPROVED]: reviewModeratedPayloadSchema,
  [EVENT_TYPES.REVIEW_REJECTED]: reviewModeratedPayloadSchema,
  [EVENT_TYPES.REVIEW_FLAGGED]: reviewModeratedPayloadSchema,
  [EVENT_TYPES.REVIEW_UNPUBLISHED]: reviewUnpublishedPayloadSchema,
};

/**
 * Parses `outbox.payload` back into the envelope shape
 * {@link EventEnvelope} describes. The column holds the *whole* envelope
 * (`eventId`, `eventType`, `version`, `occurredAt`, `aggregateType`,
 * `aggregateId`, `payload`) — confirmed against `writeOutboxEvent` in
 * `@reviews/db` — so this hands the parsed result straight to
 * `EventPublisher.publish` with no reconstruction. Thrown errors (an
 * unrecognised `eventType`, or a payload that no longer matches its own
 * schema) are treated by the caller exactly like a broker publish failure:
 * the row's `attempts`/`last_error` are recorded and it is retried, rather
 * than crashing the whole batch.
 */
export function parseEnvelope(payload: unknown): EventEnvelope {
  const value: unknown = typeof payload === 'string' ? (JSON.parse(payload) as unknown) : payload;
  const candidate = value as { eventType?: unknown } | null;
  const typeResult = eventTypeSchema.safeParse(candidate?.eventType);
  if (!typeResult.success) {
    throw new Error('outbox relay: stored payload has no recognised eventType');
  }

  const schema: ZodTypeAny | undefined = PAYLOAD_SCHEMAS[typeResult.data];
  if (!schema) {
    throw new Error(`outbox relay: unknown event type "${typeResult.data}"`);
  }

  const parsed = eventEnvelopeSchema(schema).safeParse(value);
  if (!parsed.success) {
    throw new Error(`outbox relay: stored payload failed validation: ${parsed.error.message}`);
  }

  return parsed.data as EventEnvelope;
}

/** One row claimed off the outbox, its payload already parsed into a publishable envelope. */
export interface ClaimedOutboxRow {
  id: bigint;
  attempts: number;
  envelope: EventEnvelope;
}

interface ClaimBatchRow {
  id: bigint;
  payload: unknown;
  attempts: number;
}

/**
 * The relay's one point of contact with the `outbox` table. Every method
 * that must share the batch's atomicity (`claimBatch`, `markPublished`)
 * takes the caller's `Prisma.TransactionClient` explicitly rather than
 * reaching for `this.prisma`; `recordFailure` does the opposite on
 * purpose — see its own doc comment.
 */
@Injectable()
export class OutboxRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Claims up to `limit` unpublished, not-yet-parked rows and locks them
   * for the caller's transaction: `FOR UPDATE` is what stops two relay
   * instances claiming the same row, and `SKIP LOCKED` is what stops the
   * second instance blocking behind the first's lock instead of moving on
   * to the rows the first one didn't take. `ORDER BY id` preserves
   * per-aggregate ordering — the insertion order rows were written in —
   * which matters for a pair like `review.unpublished` then
   * `review.submitted` emitted for the same aggregate.
   */
  async claimBatch(tx: Prisma.TransactionClient, limit: number, maxAttempts: number): Promise<ClaimedOutboxRow[]> {
    const rows = await tx.$queryRaw<ClaimBatchRow[]>`
      SELECT id, payload, attempts
      FROM outbox
      WHERE published_at IS NULL AND attempts < ${maxAttempts}
      ORDER BY id
      FOR UPDATE SKIP LOCKED
      LIMIT ${limit}
    `;

    return rows.map((row) => ({
      id: row.id,
      attempts: row.attempts,
      envelope: parseEnvelope(row.payload),
    }));
  }

  /** Marks `id` published, inside the same transaction its publish confirmed in. */
  async markPublished(tx: Prisma.TransactionClient, id: bigint): Promise<void> {
    await tx.outboxEvent.update({ where: { id }, data: { publishedAt: new Date() } });
  }

  /**
   * Records a failed publish attempt for `id` in its own transaction —
   * deliberately not the batch's `tx` — so one poisonous row's failure
   * can never roll back the successful publishes committed beside it in
   * the same batch. Called only after the batch transaction has already
   * committed. Returns the row's attempt count after the increment, so
   * the caller can decide whether this attempt just parked it.
   */
  async recordFailure(id: bigint, message: string): Promise<number> {
    const updated = await this.prisma.outboxEvent.update({
      where: { id },
      data: { attempts: { increment: 1 }, lastError: message },
      select: { attempts: true },
    });
    return updated.attempts;
  }
}
