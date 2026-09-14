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
    // The user who made the decision. With hard-delete-and-cascade on
    // `reviews` (see ReviewsRepository.remove's doc comment), this event —
    // not a column on the row, which may not outlive the decision — is the
    // only durable record of who moderated what. Required, not nullable:
    // `POST /moderation/reviews/:id` is MODERATOR-only, so a manual
    // decision always has a real actor. An automatic classifier's FLAGGED
    // event (a later plan) has no human actor yet; that gap is for
    // whichever plan wires that path up to resolve, not solved here.
    moderatorId: z.string().uuid(),
  })
  .strict();
export type ReviewModeratedPayload = z.infer<typeof reviewModeratedPayloadSchema>;

export const reviewUnpublishedPayloadSchema = z
  .object({
    reviewId: z.string().uuid(),
    productId: z.string().uuid(),
  })
  .strict();
export type ReviewUnpublishedPayload = z.infer<typeof reviewUnpublishedPayloadSchema>;
