import { createReviewInputSchema, reviewDtoSchema, updateReviewInputSchema } from '@reviews/contracts';
import { createZodDto } from 'nestjs-zod';
import { reviewListSchema } from '../reviews.service.js';

// See auth/dto/auth.dto.ts for why these classes exist and why the
// controllers never construct them. Covers ReviewsController (list/submit),
// ReviewManagementController (update/remove), and MyReviewsController.
export class CreateReviewRequestDto extends createZodDto(createReviewInputSchema) {}
export class UpdateReviewRequestDto extends createZodDto(updateReviewInputSchema) {}
export class ReviewResponseDto extends createZodDto(reviewDtoSchema) {}

// `reviewListSchema` (`paginatedSchema(reviewDtoSchema)`) is imported from
// the service rather than redefined here — see reviews.service.ts's doc
// comment on it, and products/dto/products.dto.ts for the same pattern.
export class ReviewListResponseDto extends createZodDto(reviewListSchema) {}
