import { z } from 'zod';
import { reviewDtoSchema } from './review.js';

export const moderationDecisionInputSchema = z.object({
  decision: z.enum(['APPROVED', 'REJECTED']),
  reason: z.string().nullable(),
});
export type ModerationDecisionInput = z.infer<typeof moderationDecisionInputSchema>;

/**
 * `ReviewDto` plus the product it's about — `name` and `slug`, enough to
 * both display and link to it. This is deliberately its own schema, not
 * an extra field on `reviewDtoSchema` itself: the public review list
 * (`GET /products/:productId/reviews`) is read from a product's own page,
 * where the product is already on screen, so adding it there would be
 * redundant weight on the hottest read path in the app. The moderation
 * queue is the one listing that spans many products at once (a moderator
 * works through everything flagged or pending, not one product's
 * reviews), so it's the one place a bare `productId` genuinely isn't
 * enough: a moderator deciding whether a borderline review should be
 * published needs to know it's about a desk lamp, not a coffee machine —
 * tone, vocabulary, and plausibility all read differently against the
 * product it's for.
 */
export const moderationReviewDtoSchema = reviewDtoSchema.extend({
  product: z.object({
    name: z.string(),
    slug: z.string(),
  }),
});
export type ModerationReviewDto = z.infer<typeof moderationReviewDtoSchema>;
