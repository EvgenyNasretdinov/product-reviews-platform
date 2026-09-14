import { z } from 'zod';

export const EVENT_TYPES = {
  REVIEW_SUBMITTED: 'review.submitted',
  REVIEW_APPROVED: 'review.approved',
  REVIEW_REJECTED: 'review.rejected',
  REVIEW_FLAGGED: 'review.flagged',
  REVIEW_UNPUBLISHED: 'review.unpublished',
} as const;

export type EventType = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES];

export const eventTypeSchema = z.enum([
  EVENT_TYPES.REVIEW_SUBMITTED,
  EVENT_TYPES.REVIEW_APPROVED,
  EVENT_TYPES.REVIEW_REJECTED,
  EVENT_TYPES.REVIEW_FLAGGED,
  EVENT_TYPES.REVIEW_UNPUBLISHED,
]);

// `.strict()` on the envelope and on every payload schema below: plain
// `z.object` silently strips unknown keys rather than rejecting them, which
// is the wrong failure mode for the outbox. `writeOutboxEvent` is the one
// gate that validates a payload before it becomes a durable, published
// record — with a lenient schema it catches a *missing* field but not an
// *extra* one, so a caller that adds a field to a payload literal without
// also updating its schema silently loses that field at the one place in
// this system meant to be a permanent record of what happened. `.strict()`
// turns that into a thrown OutboxValidationError instead — see
// events.test.ts's "rejects a payload with an unknown field" and
// outbox.test.ts's matching case.
export function eventEnvelopeSchema<T extends z.ZodTypeAny>(payload: T) {
  return z
    .object({
      eventId: z.string().uuid(),
      eventType: eventTypeSchema,
      version: z.literal(1),
      occurredAt: z.coerce.date(),
      aggregateType: z.literal('review'),
      aggregateId: z.string().uuid(),
      payload,
    })
    .strict();
}

export const reviewSubmittedPayloadSchema = z
  .object({
    reviewId: z.string().uuid(),
    productId: z.string().uuid(),
    authorId: z.string().uuid(),
    rating: z.number().int().min(1).max(5),
    title: z.string(),
    body: z.string(),
    verifiedPurchase: z.boolean(),
  })
  .strict();
export type ReviewSubmittedPayload = z.infer<typeof reviewSubmittedPayloadSchema>;

export const reviewModeratedPayloadSchema = z
  .object({
    reviewId: z.string().uuid(),
    productId: z.string().uuid(),
    status: z.enum(['APPROVED', 'REJECTED', 'FLAGGED']),
    moderationReason: z.string().nullable(),
    // Which *kind* of actor made this decision — a human moderator through
    // `POST /moderation/reviews/:id`, or the automatic classifier consuming
    // `review.submitted`. Needed alongside `moderatorId` rather than
    // instead of it: a bare nullable `moderatorId` would make `null` mean
    // both "the policy decided this" and "we forgot to record who did",
    // and telling a human decision apart from an automatic one is exactly
    // the question an audit trail exists to answer. A `'system'` sentinel
    // inside a uuid field was rejected for the same reason in reverse — a
    // type that lies about itself.
    decidedBy: z.enum(['MODERATOR', 'AUTOMATIC']),
    // The user who made the decision, when `decidedBy` is `'MODERATOR'`.
    // With hard-delete-and-cascade on `reviews` (see
    // ReviewsRepository.remove's doc comment), this event — not a column on
    // the row, which may not outlive the decision — is the only durable
    // record of who moderated what. Nullable because the automatic
    // classifier has no human actor to record; the refine below is what
    // keeps this field and `decidedBy` from ever disagreeing.
    moderatorId: z.string().uuid().nullable(),
  })
  .strict()
  .refine((payload) => (payload.decidedBy === 'MODERATOR' ? payload.moderatorId !== null : payload.moderatorId === null), {
    message: 'moderatorId must be set exactly when decidedBy is MODERATOR, and null when AUTOMATIC',
    path: ['moderatorId'],
  });
export type ReviewModeratedPayload = z.infer<typeof reviewModeratedPayloadSchema>;

export const reviewUnpublishedPayloadSchema = z
  .object({
    reviewId: z.string().uuid(),
    productId: z.string().uuid(),
  })
  .strict();
export type ReviewUnpublishedPayload = z.infer<typeof reviewUnpublishedPayloadSchema>;

/**
 * Maps every domain event type to the Zod schema its business payload must
 * satisfy — the one canonical copy. Before this, `@reviews/db`'s
 * `writeOutboxEvent`, the worker's outbox relay, and the worker's consumer
 * plumbing each carried their own hand-copy of this same map, with a
 * comment on each explaining why it was duplicated rather than shared.
 * That was a maintenance cost, not a correctness one — all three were
 * typed `Record<EventType, ZodTypeAny>`, so a new `EventType` missing from
 * any one of them was already a compile error in that package, not a
 * silent gap — but three copies of the same mapping is still three places
 * that can drift out of sync in everything except that one checked
 * property. `@reviews/contracts` is the layer every one of those packages
 * already depends on, so this is the one place all three can import from
 * without creating a new or backwards dependency.
 *
 * `REVIEW_APPROVED`, `REVIEW_REJECTED`, and `REVIEW_FLAGGED` share
 * `reviewModeratedPayloadSchema` — moderation always produces one of those
 * three outcomes with the same shape.
 *
 * `as const satisfies Record<EventType, z.ZodTypeAny>` (rather than a plain
 * `: Record<EventType, z.ZodTypeAny>` annotation) is deliberate: annotating
 * the constant with that type would widen every value to the bare
 * `ZodTypeAny`, which is exactly what {@link EventEnvelope} below needs
 * *not* to happen — it depends on each entry keeping its own specific
 * schema type so the derived union has one member per event type instead
 * of collapsing into one. `satisfies` still checks the same exhaustiveness
 * (every `EventType` present, nothing extra) without that widening.
 */
export const eventPayloadSchemas = {
  [EVENT_TYPES.REVIEW_SUBMITTED]: reviewSubmittedPayloadSchema,
  [EVENT_TYPES.REVIEW_APPROVED]: reviewModeratedPayloadSchema,
  [EVENT_TYPES.REVIEW_REJECTED]: reviewModeratedPayloadSchema,
  [EVENT_TYPES.REVIEW_FLAGGED]: reviewModeratedPayloadSchema,
  [EVENT_TYPES.REVIEW_UNPUBLISHED]: reviewUnpublishedPayloadSchema,
} as const satisfies Record<EventType, z.ZodTypeAny>;

/**
 * The full envelope shape for every event type this system produces or
 * consumes — one member per key of {@link eventPayloadSchemas}, derived
 * from that map rather than hand-written as a union. A hand-written union
 * is a second place that has to be kept in sync with the map by a human
 * remembering to; forgetting was previously silent here specifically,
 * since every caller that narrows a parsed envelope down to one event
 * type does it with an `as EventEnvelope` cast (there is no schema-level
 * discriminant on `eventType` alone — see `eventEnvelopeSchema`'s doc
 * comment), so a union missing a variant would not fail to compile at
 * either call site. Deriving it instead closes that gap structurally: a
 * new entry in `eventPayloadSchemas` is automatically a new member here,
 * with nothing left to remember.
 */
// `eventEnvelopeSchema` is called here exactly once, with the broad
// `z.ZodTypeAny` rather than once per event type, specifically to sidestep
// a TypeScript limitation: a generic function's return type, instantiated
// per member inside a mapped type (`eventEnvelopeSchema<(typeof
// eventPayloadSchemas)[K]>`), does not distribute the way a plain indexed
// access does -- it resolves `(typeof eventPayloadSchemas)[K]` against K's
// *constraint* (the union of every payload schema) rather than each
// member in turn, collapsing every branch to the same (wrong) type.
// Calling it once for the shared envelope shape and varying only
// `payload` per key below avoids relying on that distribution at all.
type EnvelopeFields = Omit<z.infer<ReturnType<typeof eventEnvelopeSchema<z.ZodTypeAny>>>, 'payload'>;

type EventEnvelopeByType = {
  [K in keyof typeof eventPayloadSchemas]: EnvelopeFields & { payload: z.infer<(typeof eventPayloadSchemas)[K]> };
};
export type EventEnvelope = EventEnvelopeByType[keyof EventEnvelopeByType];
