import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { createReviewInputSchema, reviewSortSchema, updateReviewInputSchema, type ReviewDto } from '@reviews/contracts';
import { z } from 'zod';
import { CurrentUser, type AuthenticatedUser } from '../auth/decorators/current-user.decorator.js';
import { Public } from '../auth/decorators/public.decorator.js';
import { ErrorResponseDto } from '../common/openapi/error-response.dto.js';
import { ReviewSubmitThrottlerGuard } from '../common/throttle/throttle.module.js';
import { CreateReviewRequestDto, ReviewConflictResponseDto, ReviewListResponseDto, ReviewResponseDto, UpdateReviewRequestDto } from './dto/reviews.dto.js';
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

@ApiTags('reviews')
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
  @ApiOperation({ summary: 'List a product’s published reviews' })
  @ApiParam({ name: 'productId', type: String, format: 'uuid' })
  @ApiQuery({ name: 'sort', required: false, enum: ['helpful', 'newest', 'rating_desc', 'rating_asc'], description: 'Defaults to "helpful".' })
  @ApiQuery({ name: 'rating', required: false, type: Number, description: 'Filter to one star rating, 1-5.' })
  @ApiQuery({ name: 'cursor', required: false, type: String, description: 'Opaque pagination cursor from a previous page.' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Page size, 1-100 (default 20).' })
  @ApiResponse({ status: 200, type: ReviewListResponseDto })
  @ApiResponse({ status: 400, type: ErrorResponseDto, description: 'Invalid query parameters or malformed productId.' })
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
   *
   * Rate-limited via `ReviewSubmitThrottlerGuard`, applied to this one
   * handler and nowhere else on this controller — `list` above stays
   * completely unthrottled, since a browsing visitor triggering a 429
   * would be absurd. Review spam is cheap to generate and expensive for a
   * human moderator to triage, which is why the cap sits on this write
   * path specifically. See throttle.module.ts for why the counter lives
   * in Redis and how it's keyed. The actual limit isn't set here — it
   * comes from `AppEnv#reviewSubmitRateLimit` inside `ThrottleModule`'s
   * `ThrottlerModule.forRootAsync` factory, the only place it's defined.
   */
  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(ReviewSubmitThrottlerGuard)
  @ApiBearerAuth('bearer')
  @ApiOperation({ summary: 'Submit a review for a product' })
  @ApiParam({ name: 'productId', type: String, format: 'uuid' })
  @ApiBody({ type: CreateReviewRequestDto })
  @ApiResponse({ status: 202, type: ReviewResponseDto, description: 'Accepted: the review is PENDING until moderation publishes it.' })
  @ApiResponse({ status: 400, type: ErrorResponseDto, description: 'Invalid rating/title/body or malformed productId.' })
  @ApiResponse({ status: 401, type: ErrorResponseDto, description: 'Missing, expired, or invalid bearer token.' })
  @ApiResponse({ status: 404, type: ErrorResponseDto, description: 'No product has this productId.' })
  @ApiResponse({ status: 409, type: ReviewConflictResponseDto, description: 'The caller has already submitted a review for this product; `reviewId` points at it.' })
  @ApiResponse({ status: 429, type: ErrorResponseDto, description: 'Review-submission rate limit exceeded for this caller.' })
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

/**
 * The author-management routes for a single review, addressed by its own
 * id rather than nested under its product — unlike `ReviewsController`
 * above, which is scoped `products/:productId/reviews` for the
 * list/submit routes. No `@Public()` here: both handlers require
 * authentication, enforced by the global `JwtAuthGuard`.
 *
 * `id` is parsed through `ParseUUIDPipe` on both handlers — the same
 * reasoning as `VotesController`'s `reviewId`: it reaches a raw `::uuid`
 * cast inside `ReviewsRepository`'s `lockReviewRow`, and a syntactically
 * invalid uuid would otherwise fall through the global exception filter as
 * an unmapped Postgres error (500) instead of the 400 a malformed
 * client-supplied id actually warrants.
 */
@ApiTags('reviews')
@ApiBearerAuth('bearer')
@Controller('reviews')
export class ReviewManagementController {
  constructor(private readonly reviewsService: ReviewsService) {}

  /**
   * The body is parsed through the shared `updateReviewInputSchema` rather
   * than a class-validator DTO — the same reason `submit` above parses
   * `@Body() body: unknown` through `createReviewInputSchema`.
   *
   * `200`, not `202`: unlike a fresh submission, an edit's outcome (patched
   * fields, and — for a previously `APPROVED` review — the drop back to
   * `PENDING`) is already reflected in the body this handler returns.
   */
  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Edit the caller’s own review' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiBody({ type: UpdateReviewRequestDto })
  @ApiResponse({ status: 200, type: ReviewResponseDto })
  @ApiResponse({ status: 400, type: ErrorResponseDto, description: 'No fields provided, or a provided field fails validation.' })
  @ApiResponse({ status: 401, type: ErrorResponseDto, description: 'Missing, expired, or invalid bearer token.' })
  @ApiResponse({ status: 403, type: ErrorResponseDto, description: 'The review belongs to another author.' })
  @ApiResponse({ status: 404, type: ErrorResponseDto, description: 'No review has this id.' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ReviewDto> {
    const parsed = updateReviewInputSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((issue) => issue.message).join('; '));
    }

    return this.reviewsService.update(id, user.id, parsed.data);
  }

  /**
   * `204` on success — the author, or any `MODERATOR` (see
   * `ReviewsRepository.remove`'s doc comment for why a moderator may
   * delete but never edit). No role guard/decorator here: the author/
   * moderator distinction is made inside the service+repository, against
   * the row's own `authorId`, not against static route metadata.
   */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a review (its author, or any moderator)' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 204, description: 'Deleted.' })
  @ApiResponse({ status: 401, type: ErrorResponseDto, description: 'Missing, expired, or invalid bearer token.' })
  @ApiResponse({ status: 403, type: ErrorResponseDto, description: 'The caller is neither the review’s author nor a moderator.' })
  @ApiResponse({ status: 404, type: ErrorResponseDto, description: 'No review has this id.' })
  async remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser): Promise<void> {
    await this.reviewsService.remove(id, user.id, user.role);
  }
}

/**
 * `cursor` and `limit` are validated by hand through this schema — the
 * same reason `listReviewsQuerySchema` above is. No `sort`/`rating`: this
 * listing has exactly one order (newest first, see
 * `ReviewsRepository.listByAuthor`) and no filter.
 */
const listMineQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/**
 * `GET /me/reviews` — the caller's own reviews, in every status. Deliberately
 * a separate controller from `ReviewManagementController`: `@Controller`
 * only takes one path prefix, and `me/reviews` doesn't nest under `reviews`
 * the way `:id` does.
 */
@ApiTags('reviews')
@ApiBearerAuth('bearer')
@Controller('me/reviews')
export class MyReviewsController {
  constructor(private readonly reviewsService: ReviewsService) {}

  /**
   * Cursor-paginated like every other listing in this API — previously
   * returned every review the caller had ever written as a bare array,
   * with no `take` and no cursor, so a prolific author got everything in
   * one unbounded response. `ReviewListResponseDto` (the same
   * `{ items, nextCursor }` envelope the public list uses) replaces the
   * old `ReviewDto[]` response shape.
   */
  @Get()
  @ApiOperation({ summary: 'List every review the caller has authored, in every status' })
  @ApiQuery({ name: 'cursor', required: false, type: String, description: 'Opaque pagination cursor from a previous page.' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Page size, 1-100 (default 20).' })
  @ApiResponse({ status: 200, type: ReviewListResponseDto })
  @ApiResponse({ status: 400, type: ErrorResponseDto, description: 'Invalid query parameters.' })
  @ApiResponse({ status: 401, type: ErrorResponseDto, description: 'Missing, expired, or invalid bearer token.' })
  async listMine(@Query() query: unknown, @CurrentUser() user: AuthenticatedUser): Promise<ListReviewsResult> {
    const parsed = listMineQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((issue) => issue.message).join('; '));
    }

    return this.reviewsService.listMine({ authorId: user.id, ...parsed.data });
  }
}
