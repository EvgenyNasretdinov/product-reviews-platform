import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { cacheKeys, type VoteValue } from '@reviews/contracts';
import { CacheService } from '../common/cache/cache.service.js';
import {
  ReviewNotVotableError,
  ReviewsRepository,
  SelfVoteError,
  type VoteCounts,
  type VoteMutationResult,
} from './reviews.repository.js';

const logger = new Logger('VotesService');

/**
 * HTTP-shaped decisions for the voting endpoints. `ReviewsRepository` owns
 * every Prisma call and the transactional behaviour (see its `castVote` and
 * `removeVote` doc comments); this service's own job, beyond translating
 * what the repository throws into the right response (the same split
 * `ReviewsService.submit` uses for `ProductNotFoundError`), is invalidating
 * the review-list cache a vote can shift the ranking of — see
 * `invalidateReviewList` below.
 */
@Injectable()
export class VotesService {
  constructor(
    private readonly repository: ReviewsRepository,
    private readonly cache: CacheService,
  ) {}

  async castVote(reviewId: string, userId: string, value: VoteValue): Promise<VoteCounts> {
    let result: VoteMutationResult;
    try {
      result = await this.repository.castVote(reviewId, userId, value);
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

    await this.invalidateReviewList(result.productId);
    // Only `VoteCounts`' two fields go out — `result.productId` was
    // surfaced by the repository purely for the invalidation call above,
    // not to widen this endpoint's response shape (`VoteCountsResponseDto`
    // has no such field). Building a fresh object here rather than
    // returning `result` as-is is what keeps that true regardless of what
    // the repository's return type happens to carry in the future.
    return { helpfulCount: result.helpfulCount, notHelpfulCount: result.notHelpfulCount };
  }

  async removeVote(reviewId: string, userId: string): Promise<void> {
    const productId = await this.repository.removeVote(reviewId, userId);
    // `null` means `reviewId` matched no row at all — nothing changed, so
    // there is nothing to invalidate (see `ReviewsRepository.removeVote`'s
    // doc comment on why that's still a success, not a 404).
    if (productId) {
      await this.invalidateReviewList(productId);
    }
  }

  /**
   * Deletes every cached review-list page for `productId`, across every
   * sort order and rating filter — `cacheKeys.reviewListPrefix`, not
   * `reviewListFirstPage`, because a vote can shift a review's position
   * under the `helpful` sort (the only one its own counters affect) for
   * any rating filter it happens to fall under, and there is no cheaper
   * way to know which combinations without enumerating all of them. This
   * mirrors `AggregationConsumer.handle`'s own cache invalidation in the
   * worker (`apps/worker/src/aggregation/aggregation.consumer.ts`): same
   * prefix, same "log and degrade" failure handling below, because a
   * Redis outage must cost freshness up to `TTL_REVIEW_LIST`, never the
   * ability to record the vote itself. Called only after the repository's
   * `$transaction` has resolved — i.e. after the vote has committed — so
   * a reader can never observe the deleted cache entry before the row it
   * would recompute from is visible.
   */
  private async invalidateReviewList(productId: string): Promise<void> {
    try {
      await this.cache.delByPrefix(cacheKeys.reviewListPrefix(productId));
    } catch (error) {
      logger.warn(
        `cache invalidation failed for product ${productId} after a vote; ` +
          `stale entries will expire on their own TTL: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
