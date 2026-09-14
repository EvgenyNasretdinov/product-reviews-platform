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
import { ApiBearerAuth, ApiBody, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { VoteValue } from '@reviews/contracts';
import { CurrentUser, type AuthenticatedUser } from '../auth/decorators/current-user.decorator.js';
import { ErrorResponseDto } from '../common/openapi/error-response.dto.js';
import { CastVoteRequestDto, VoteCountsResponseDto, castVoteInputSchema } from './dto/votes.dto.js';
import type { VoteCounts } from './reviews.repository.js';
import { VotesService } from './votes.service.js';

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
@ApiTags('votes')
@ApiBearerAuth('bearer')
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
  @ApiOperation({ summary: 'Cast (or replace) the caller’s helpfulness vote on a review' })
  @ApiParam({ name: 'reviewId', type: String, format: 'uuid' })
  @ApiBody({ type: CastVoteRequestDto })
  @ApiResponse({ status: 200, type: VoteCountsResponseDto })
  @ApiResponse({ status: 400, type: ErrorResponseDto, description: 'Invalid vote value or malformed reviewId.' })
  @ApiResponse({ status: 401, type: ErrorResponseDto, description: 'Missing, expired, or invalid bearer token.' })
  @ApiResponse({ status: 403, type: ErrorResponseDto, description: 'A review’s own author may not vote on it.' })
  @ApiResponse({ status: 404, type: ErrorResponseDto, description: 'No approved review has this id.' })
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
  @ApiOperation({ summary: 'Remove the caller’s helpfulness vote on a review, if any' })
  @ApiParam({ name: 'reviewId', type: String, format: 'uuid' })
  @ApiResponse({ status: 204, description: 'Removed, or there was nothing to remove — both are a success.' })
  @ApiResponse({ status: 401, type: ErrorResponseDto, description: 'Missing, expired, or invalid bearer token.' })
  async remove(
    @Param('reviewId', ParseUUIDPipe) reviewId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    await this.votesService.removeVote(reviewId, user.id);
  }
}
