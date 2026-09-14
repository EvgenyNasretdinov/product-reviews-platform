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
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { moderationDecisionInputSchema, reviewStatusSchema, type ReviewDto } from '@reviews/contracts';
import { z } from 'zod';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { ErrorResponseDto } from '../common/openapi/error-response.dto.js';
import { ModerationDecisionRequestDto, ModerationQueueResponseDto } from './dto/moderation.dto.js';
import { ModerationService, type ListQueueResult } from './moderation.service.js';
import { ReviewResponseDto } from '../reviews/dto/reviews.dto.js';

/**
 * `status`, `cursor`, and `limit` are validated by hand through this
 * schema rather than Nest's class-validator `ValidationPipe` — the same
 * reason `ReviewsController`'s `listReviewsQuerySchema` is: the global pipe
 * skips a plain-object query param with no class-validator metatype, so a
 * bare `@Query() query: unknown` reaches the handler unvalidated otherwise.
 *
 * `status` defaults to `FLAGGED` — the reviews an automatic classifier
 * (a later plan) couldn't decide on its own and routed here for a human.
 */
const listQueueQuerySchema = z.object({
  status: reviewStatusSchema.default('FLAGGED'),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/**
 * Both routes are `MODERATOR`-only: `@UseGuards(RolesGuard)` plus
 * `@Roles('MODERATOR')` at the controller level, on top of the always-on
 * global `JwtAuthGuard` (see AuthModule). The two guards answer two
 * different failures — no token at all is a 401 from `JwtAuthGuard`,
 * before `RolesGuard` ever runs; an authenticated `CUSTOMER` is a 403 from
 * `RolesGuard`. `RolesGuard` and `@Roles` were built in Task 7 and left
 * unwired until this task, deliberately — a route existing only to test a
 * guard is worse than a deferred test.
 */
@ApiTags('moderation')
@ApiBearerAuth('bearer')
@Controller('moderation/reviews')
@UseGuards(RolesGuard)
@Roles('MODERATOR')
export class ModerationController {
  constructor(private readonly moderationService: ModerationService) {}

  @Get()
  @ApiOperation({ summary: 'List the moderation queue (MODERATOR only)' })
  @ApiQuery({ name: 'status', required: false, enum: ['PENDING', 'APPROVED', 'REJECTED', 'FLAGGED'], description: 'Defaults to "FLAGGED".' })
  @ApiQuery({ name: 'cursor', required: false, type: String, description: 'Opaque pagination cursor from a previous page.' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Page size, 1-100 (default 20).' })
  @ApiResponse({ status: 200, type: ModerationQueueResponseDto })
  @ApiResponse({ status: 401, type: ErrorResponseDto, description: 'Missing, expired, or invalid bearer token.' })
  @ApiResponse({ status: 403, type: ErrorResponseDto, description: 'The caller is not a MODERATOR.' })
  async listQueue(@Query() query: unknown): Promise<ListQueueResult> {
    const parsed = listQueueQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((issue) => issue.message).join('; '));
    }

    return this.moderationService.listQueue(parsed.data);
  }

  /**
   * The body is parsed through the shared `moderationDecisionInputSchema`
   * rather than a class-validator DTO, the same reason every other mutating
   * handler in this API parses `@Body() body: unknown` by hand.
   *
   * `id` is parsed through `ParseUUIDPipe` — the same reasoning as
   * `ReviewManagementController`'s `id`: it reaches a Postgres `::uuid`
   * filter inside `ReviewsRepository.decide`'s `updateMany`, and a
   * syntactically invalid uuid would otherwise fall through the global
   * exception filter as an unmapped Postgres error (500) instead of the
   * 400 a malformed client-supplied id actually warrants.
   *
   * `200`, not `201`/`202`/`204`: this always updates an existing review
   * and returns its new state in the body.
   */
  @Post(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Record a moderation decision for a review (MODERATOR only)' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiBody({ type: ModerationDecisionRequestDto })
  @ApiResponse({ status: 200, type: ReviewResponseDto })
  @ApiResponse({ status: 400, type: ErrorResponseDto, description: 'REJECTED with no reason, or malformed input.' })
  @ApiResponse({ status: 401, type: ErrorResponseDto, description: 'Missing, expired, or invalid bearer token.' })
  @ApiResponse({ status: 403, type: ErrorResponseDto, description: 'The caller is not a MODERATOR.' })
  @ApiResponse({ status: 404, type: ErrorResponseDto, description: 'No review has this id.' })
  @ApiResponse({ status: 409, type: ErrorResponseDto, description: 'The review is not awaiting moderation.' })
  async decide(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown): Promise<ReviewDto> {
    const parsed = moderationDecisionInputSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((issue) => issue.message).join('; '));
    }

    return this.moderationService.decide(id, parsed.data);
  }
}
