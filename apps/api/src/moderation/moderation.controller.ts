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
import { moderationDecisionInputSchema, reviewStatusSchema, type ReviewDto } from '@reviews/contracts';
import { z } from 'zod';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { ModerationService, type ListQueueResult } from './moderation.service.js';

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
@Controller('moderation/reviews')
@UseGuards(RolesGuard)
@Roles('MODERATOR')
export class ModerationController {
  constructor(private readonly moderationService: ModerationService) {}

  @Get()
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
  async decide(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown): Promise<ReviewDto> {
    const parsed = moderationDecisionInputSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((issue) => issue.message).join('; '));
    }

    return this.moderationService.decide(id, parsed.data);
  }
}
