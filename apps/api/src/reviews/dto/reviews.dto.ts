import { createReviewInputSchema, reviewDtoSchema, updateReviewInputSchema } from '@reviews/contracts';
import { createZodDto } from 'nestjs-zod';
import { errorResponseSchema } from '../../common/openapi/error-response.dto.js';
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

// The 409 `ReviewsService#submit` throws on a duplicate submission carries
// a `reviewId` alongside the generic error fields (see
// `ConflictException({ statusCode, message, reviewId })` there) — that
// field is the whole point of this response: it's how a client navigates
// straight to the review that already exists, rather than having to
// re-fetch the list to find it. `errorResponseSchema.extend(...)` keeps
// this tied to the one shared error shape instead of redeclaring
// `statusCode`/`message` a second time.
const reviewConflictResponseSchema = errorResponseSchema.extend({
  reviewId: reviewDtoSchema.shape.id.optional(),
});
export class ReviewConflictResponseDto extends createZodDto(reviewConflictResponseSchema) {}
