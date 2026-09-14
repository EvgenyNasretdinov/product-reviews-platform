import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Put,
} from '@nestjs/common';
import { voteValueSchema, type VoteValue } from '@reviews/contracts';
import { z } from 'zod';
import { CurrentUser, type AuthenticatedUser } from '../auth/decorators/current-user.decorator.js';
import type { VoteCounts } from './reviews.repository.js';
import { VotesService } from './votes.service.js';

/**
 * The body is parsed through this schema rather than a class-validator DTO
 * — the same reason `ReviewsController#submit` parses `@Body() body:
 * unknown` through `createReviewInputSchema`: the global `ValidationPipe`
 * only validates typed class-validator metatypes, so a bare `unknown` body
 * reaches the handler unvalidated otherwise.
 */
const castVoteInputSchema = z.object({ value: voteValueSchema });

/**
 * No `@Public()` here, on either handler: both require authentication, and
 * the global `JwtAuthGuard` enforces that by default (see the decorator's
 * doc comment) — this controller simply never opts out of it.
 *
 * `reviewId` is parsed through `ParseUUIDPipe` on both handlers: it reaches
 * a raw `::uuid` cast inside `ReviewsRepository`'s `lockReviewRow`/
 * `recomputeVoteCounts` (see reviews.repository.ts), and Postgres rejects a
 * syntactically invalid uuid with error `22P02` — a code the global
 * `PrismaExceptionFilter` doesn't recognise (it only maps `P2002`/`P2025`),
 * so it would otherwise fall through to a 500 for what is really a 400: a
 * client sent a malformed id. `ParseUUIDPipe` rejects it before it ever
 * reaches the repository.
 */
@Controller('reviews/:reviewId/vote')
export class VotesController {
  constructor(private readonly votesService: VotesService) {}

  /**
   * `200`, not `201` or `202`: a vote either creates or replaces the single
   * `(reviewId, userId)` row, and either way the response is the review's
   * current counters, not a newly created resource.
   */
  @Put()
  @HttpCode(HttpStatus.OK)
  async vote(
    @Param('reviewId', ParseUUIDPipe) reviewId: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<VoteCounts> {
    const parsed = castVoteInputSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((issue) => issue.message).join('; '));
    }
    const value: VoteValue = parsed.data.value;

    return this.votesService.castVote(reviewId, user.id, value);
  }

  /**
   * `204` unconditionally, including when the caller had no vote to remove
   * — see `ReviewsRepository.removeVote`'s doc comment for why that's a
   * success, not a 404.
   */
  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('reviewId', ParseUUIDPipe) reviewId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    await this.votesService.removeVote(reviewId, user.id);
  }
}
