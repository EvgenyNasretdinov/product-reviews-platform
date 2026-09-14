import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { VoteValue } from '@reviews/contracts';
import { ReviewNotVotableError, ReviewsRepository, SelfVoteError, type VoteCounts } from './reviews.repository.js';

/**
 * HTTP-shaped decisions for the voting endpoints. `ReviewsRepository` owns
 * every Prisma call and the transactional behaviour (see its `castVote` and
 * `removeVote` doc comments); this service's only job is translating what
 * the repository throws into the right response, the same split
 * `ReviewsService.submit` uses for `ProductNotFoundError`.
 */
@Injectable()
export class VotesService {
  constructor(private readonly repository: ReviewsRepository) {}

  async castVote(reviewId: string, userId: string, value: VoteValue): Promise<VoteCounts> {
    try {
      return await this.repository.castVote(reviewId, userId, value);
    } catch (error) {
      if (error instanceof ReviewNotVotableError) {
        // Deliberately the same 404 a nonexistent review would get — see
        // ReviewNotVotableError's doc comment.
        throw new NotFoundException('Review not found');
      }
      if (error instanceof SelfVoteError) {
        throw new ForbiddenException('You cannot vote on your own review');
      }
      throw error;
    }
  }

  async removeVote(reviewId: string, userId: string): Promise<void> {
    await this.repository.removeVote(reviewId, userId);
  }
}
