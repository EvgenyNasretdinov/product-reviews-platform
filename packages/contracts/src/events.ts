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

export function eventEnvelopeSchema<T extends z.ZodTypeAny>(payload: T) {
  return z.object({
    eventId: z.string().uuid(),
    eventType: eventTypeSchema,
    version: z.literal(1),
    occurredAt: z.coerce.date(),
    aggregateType: z.literal('review'),
    aggregateId: z.string().uuid(),
    payload,
  });
}

export const reviewSubmittedPayloadSchema = z.object({
  reviewId: z.string().uuid(),
  productId: z.string().uuid(),
  authorId: z.string().uuid(),
  rating: z.number().int().min(1).max(5),
  title: z.string(),
  body: z.string(),
  verifiedPurchase: z.boolean(),
});
export type ReviewSubmittedPayload = z.infer<typeof reviewSubmittedPayloadSchema>;

export const reviewModeratedPayloadSchema = z.object({
  reviewId: z.string().uuid(),
  productId: z.string().uuid(),
  status: z.enum(['APPROVED', 'REJECTED', 'FLAGGED']),
  moderationReason: z.string().nullable(),
});
export type ReviewModeratedPayload = z.infer<typeof reviewModeratedPayloadSchema>;

export const reviewUnpublishedPayloadSchema = z.object({
  reviewId: z.string().uuid(),
  productId: z.string().uuid(),
});
export type ReviewUnpublishedPayload = z.infer<typeof reviewUnpublishedPayloadSchema>;
