import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { createReviewInputSchema, reviewSortSchema, type ReviewDto } from '@reviews/contracts';
import { z } from 'zod';
import { CurrentUser, type AuthenticatedUser } from '../auth/decorators/current-user.decorator.js';
import { Public } from '../auth/decorators/public.decorator.js';
import { ReviewsService, type ListReviewsResult } from './reviews.service.js';

/**
 * `sort`, `rating`, `cursor`, and `limit` are validated by hand through
 * this schema rather than Nest's class-validator `ValidationPipe` — the
 * same reason `ProductsController#list`'s `listProductsQuerySchema` is:
 * the global pipe skips a plain-object query param with no class-validator
 * metatype, so a bare `@Query() query: unknown` reaches the handler
 * unvalidated otherwise.
 */
const listReviewsQuerySchema = z.object({
  sort: reviewSortSchema,
  rating: z.coerce.number().int().min(1).max(5).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

// `productId` is parsed through `ParseUUIDPipe` on both handlers below: it
// reaches Postgres as a `@db.Uuid` column filter either way, and a
// syntactically malformed id would otherwise surface as an unmapped
// Postgres error (falling through the global exception filter to a 500)
// rather than the 400 a malformed client-supplied id actually warrants —
// see votes.controller.ts's doc comment for the fuller version of this
// reasoning, first found there.

@Controller('products/:productId/reviews')
export class ReviewsController {
  constructor(private readonly reviewsService: ReviewsService) {}

  /**
   * The public review list for one product — `APPROVED` reviews only.
   * `@Public()` on this handler specifically, not the whole controller:
   * `POST` below stays behind the global `JwtAuthGuard`, this `GET` opts
   * out of it, the same way `ProductsController` does at the class level
   * for a controller that is public end to end.
   */
  @Public()
  @Get()
  async list(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Query() query: unknown,
  ): Promise<ListReviewsResult> {
    const parsed = listReviewsQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((issue) => issue.message).join('; '));
    }

    return this.reviewsService.list({ productId, ...parsed.data });
  }

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
    @Param('productId', ParseUUIDPipe) productId: string,
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
