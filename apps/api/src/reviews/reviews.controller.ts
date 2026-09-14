import { BadRequestException, Body, Controller, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { createReviewInputSchema, type ReviewDto } from '@reviews/contracts';
import { CurrentUser, type AuthenticatedUser } from '../auth/decorators/current-user.decorator.js';
import { ReviewsService } from './reviews.service.js';

@Controller('products/:productId/reviews')
export class ReviewsController {
  constructor(private readonly reviewsService: ReviewsService) {}

  /**
   * The body is parsed through the shared `createReviewInputSchema` rather
   * than a class-validator DTO, the same reason `AuthController#login`
   * does: `@Body() body: unknown` bypasses the global `ValidationPipe`
   * (it only validates typed class-validator metatypes), so this schema is
   * what actually enforces the rating/title/body constraints.
   *
   * Answers `202 Accepted`, not `201 Created`: the review is persisted but
   * starts life `PENDING`, unpublished until a later moderation step
   * approves it, and `201` would claim a visibility this response hasn't
   * delivered.
   */
  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  async submit(
    @Param('productId') productId: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ReviewDto> {
    const parsed = createReviewInputSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((issue) => issue.message).join('; '));
    }

    return this.reviewsService.submit({ productId, authorId: user.id, input: parsed.data });
  }
}
