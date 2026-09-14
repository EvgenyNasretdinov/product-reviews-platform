import {
  EVENT_TYPES,
  eventEnvelopeSchema,
  reviewModeratedPayloadSchema,
  reviewSubmittedPayloadSchema,
  reviewUnpublishedPayloadSchema,
  type EventType,
} from '@reviews/contracts';
import type { Prisma } from '@prisma/client';
import { v7 as uuidv7 } from 'uuid';
import type { ZodTypeAny } from 'zod';

/**
 * Maps every domain event type to the Zod schema its business payload must
 * satisfy. `REVIEW_APPROVED`, `REVIEW_REJECTED`, and `REVIEW_FLAGGED` share
 * `reviewModeratedPayloadSchema` — moderation always produces one of those
 * three outcomes with the same shape (see `@reviews/contracts`'s events.ts).
 *
 * Typed as `Record<EventType, ZodTypeAny>` so the mapping is exhaustive at
 * compile time: adding a new `EventType` without adding its schema here is
 * a TypeScript error, not a gap `writeOutboxEvent` would only discover the
 * first time someone calls it with the new type.
 */
const PAYLOAD_SCHEMAS: Record<EventType, ZodTypeAny> = {
  [EVENT_TYPES.REVIEW_SUBMITTED]: reviewSubmittedPayloadSchema,
  [EVENT_TYPES.REVIEW_APPROVED]: reviewModeratedPayloadSchema,
  [EVENT_TYPES.REVIEW_REJECTED]: reviewModeratedPayloadSchema,
  [EVENT_TYPES.REVIEW_FLAGGED]: reviewModeratedPayloadSchema,
  [EVENT_TYPES.REVIEW_UNPUBLISHED]: reviewUnpublishedPayloadSchema,
};

export interface WriteOutboxEventInput {
  eventType: EventType;
  aggregateId: string;
  payload: unknown;
}

/**
 * Thrown by {@link writeOutboxEvent} before any insert is attempted —
 * either the event type isn't recognised, or the payload fails the schema
 * for its type. A plain `Error` subclass, not a framework exception: this
 * module has no NestJS dependency (see the file-level doc comment), so
 * there is nothing Nest-specific to throw.
 */
export class OutboxValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OutboxValidationError';
  }
}

/**
 * Writes one row to the transactional outbox, inside the caller's own
 * transaction. This is how every state change in this codebase emits its
 * domain event: never as a separate write after the fact, so a rollback of
 * the caller's transaction always takes the event with it, and a commit
 * never leaves an event unrecorded. See `apps/api/src/reviews/reviews.repository.ts`
 * for the reference caller, and its integration test's "writes no outbox
 * event when the submission conflicts" case for the property this buys.
 *
 * Deliberately a plain function with no NestJS dependency: it lives in
 * `@reviews/db` rather than the API because a later worker process
 * (moderation consumer, Plan 2) writes outbox rows too, from a bare
 * handler with no Nest DI container — a Nest `Injectable` here would be
 * unusable from that context.
 *
 * The `outbox.payload` JSON column stores the full event envelope
 * (`eventEnvelopeSchema`'s shape: `eventId`, `eventType`, `version`,
 * `occurredAt`, `aggregateType`, `aggregateId`, and the caller's business
 * `payload`), not just the caller's payload on its own — the outbox table
 * has no dedicated columns for `eventId` or `version`, and this is what
 * lets the relay (Plan 2) publish the stored JSON to the broker unchanged,
 * without reconstructing it. `eventId` is generated here as a UUIDv7 (so
 * it sorts with generation order, unlike v4) and `occurredAt` is stamped
 * here too, once, and reused for both the envelope and the row's own
 * `occurredAt` column.
 *
 * Both failure modes are validated — and therefore raised, as
 * {@link OutboxValidationError} — before `tx.outboxEvent.create` ever
 * runs: an `eventType` this module doesn't recognise, and a `payload` that
 * fails the schema matching whatever type *was* given.
 */
export async function writeOutboxEvent(tx: Prisma.TransactionClient, event: WriteOutboxEventInput): Promise<void> {
  const payloadSchema: ZodTypeAny | undefined = PAYLOAD_SCHEMAS[event.eventType];
  if (!payloadSchema) {
    throw new OutboxValidationError(`writeOutboxEvent: unknown event type "${String(event.eventType)}"`);
  }

  const occurredAt = new Date();
  const parsed = eventEnvelopeSchema(payloadSchema).safeParse({
    eventId: uuidv7(),
    eventType: event.eventType,
    version: 1,
    occurredAt,
    aggregateType: 'review',
    aggregateId: event.aggregateId,
    payload: event.payload,
  });
  if (!parsed.success) {
    throw new OutboxValidationError(
      `writeOutboxEvent: payload does not match the schema for event type "${event.eventType}": ${parsed.error.message}`,
    );
  }

  const envelope = parsed.data;
  await tx.outboxEvent.create({
    data: {
      aggregateType: envelope.aggregateType,
      aggregateId: envelope.aggregateId,
      eventType: envelope.eventType,
      occurredAt,
      // JSON has no Date type, so the envelope's occurredAt is serialised
      // to an ISO string for storage — the DB row's own `occurredAt`
      // column (set above) is what stays a real timestamp for querying.
      payload: {
        ...envelope,
        occurredAt: envelope.occurredAt.toISOString(),
      },
    },
  });
}
