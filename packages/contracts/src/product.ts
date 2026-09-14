import { z } from 'zod';

export const ratingSummaryDtoSchema = z.object({
  productId: z.string().uuid(),
  reviewCount: z.number().int().nonnegative(),
  averageRating: z.number(),
  distribution: z.object({
    1: z.number().int().nonnegative(),
    2: z.number().int().nonnegative(),
    3: z.number().int().nonnegative(),
    4: z.number().int().nonnegative(),
    5: z.number().int().nonnegative(),
  }),
});
export type RatingSummaryDto = z.infer<typeof ratingSummaryDtoSchema>;

export const productDtoSchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  imageUrl: z.string().url().nullable(),
  priceCents: z.number().int().nonnegative(),
  currency: z.string(),
});
export type ProductDto = z.infer<typeof productDtoSchema>;

export const productDetailDtoSchema = productDtoSchema.extend({
  summary: ratingSummaryDtoSchema,
});
export type ProductDetailDto = z.infer<typeof productDetailDtoSchema>;
