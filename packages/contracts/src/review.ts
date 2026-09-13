import { z } from 'zod';

export const reviewStatusSchema = z.enum(['PENDING', 'APPROVED', 'REJECTED', 'FLAGGED']);
export type ReviewStatus = z.infer<typeof reviewStatusSchema>;

export const voteValueSchema = z.enum(['HELPFUL', 'NOT_HELPFUL']);
export type VoteValue = z.infer<typeof voteValueSchema>;

export const reviewSortSchema = z
  .enum(['helpful', 'newest', 'rating_desc', 'rating_asc'])
  .default('helpful');
export type ReviewSort = z.infer<typeof reviewSortSchema>;

export const createReviewInputSchema = z.object({
  rating: z.number().int().min(1).max(5),
  title: z.string().trim().min(3).max(120),
  body: z.string().trim().min(10).max(5000),
});
export type CreateReviewInput = z.infer<typeof createReviewInputSchema>;

export const updateReviewInputSchema = createReviewInputSchema
  .partial()
  .refine((patch) => Object.values(patch).some((v) => v !== undefined), {
    message: 'at least one field must be provided',
  });
export type UpdateReviewInput = z.infer<typeof updateReviewInputSchema>;

export const reviewDtoSchema = z.object({
  id: z.string().uuid(),
  productId: z.string().uuid(),
  author: z.object({
    id: z.string().uuid(),
    displayName: z.string(),
  }),
  rating: z.number().int().min(1).max(5),
  title: z.string(),
  body: z.string(),
  status: reviewStatusSchema,
  verifiedPurchase: z.boolean(),
  helpfulCount: z.number().int().nonnegative(),
  notHelpfulCount: z.number().int().nonnegative(),
  createdAt: z.coerce.date(),
  publishedAt: z.coerce.date().nullable(),
  moderationReason: z.string().nullable(),
});
export type ReviewDto = z.infer<typeof reviewDtoSchema>;
