import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { moderationReviewDtoSchema, paginatedSchema, type ModerationDecisionInput, type ReviewDto, type ReviewStatus } from '@reviews/contracts';
import type { z } from 'zod';
import { decodeCursor, encodeCursor } from '../common/pagination/cursor.js';
import { toModerationReviewDto, toReviewDto } from '../reviews/reviews.mapper.js';
import { cursorKeyFor, ReviewNotAwaitingModerationError, ReviewNotFoundError, ReviewsRepository } from '../reviews/reviews.repository.js';

/** The cursor scope for the moderation queue — see cursor.ts for why a cursor is scoped at all. */
const CURSOR_SCOPE = 'moderation-queue';

export interface ListQueueQuery {
  status: ReviewStatus;
  cursor?: string;
  limit: number;
}

// Derived from the shared contract rather than hand-restated — see
// products.service.ts's `productListSchema` for why: if `paginatedSchema`'s
// field names ever change, this type (and every call site that builds one)
// fails to compile instead of silently drifting from the contract.
//
// `moderationReviewDtoSchema`, not `reviewDtoSchema` — every other listing
// in this codebase returns a plain `ReviewDto`; this is the one place that
// also carries `product` (`name`/`slug`), since this is the one listing
// that spans many products at once. See that schema's doc comment
// (`@reviews/contracts`) for why it isn't just folded into `ReviewDto`
// itself.
export const moderationQueueSchema = paginatedSchema(moderationReviewDtoSchema);
export type ListQueueResult = z.infer<typeof moderationQueueSchema>;

@Injectable()
export class ModerationService {
  constructor(private readonly repository: ReviewsRepository) {}

  /**
   * The moderator's queue: every review in `query.status` (`FLAGGED` by
   * default — the reviews an automatic classifier couldn't decide on its
   * own), newest first, with the full body, author display name, and the
   * product it's about — see `ReviewsRepository.listQueue`'s doc comment
   * for why `toModerationReviewDto`, not `toReviewDto` or
   * `toPublicReviewDto`, is the right mapper here.
   */
  async listQueue(query: ListQueueQuery): Promise<ListQueueResult> {
    const cursor = query.cursor ? decodeCursor(query.cursor, CURSOR_SCOPE) : undefined;

    const { rows, hasMore } = await this.repository.listQueue({
      status: query.status,
      limit: query.limit,
      cursor,
    });

    const items = rows.map(toModerationReviewDto);
    const last = rows.at(-1);
    const nextCursor = hasMore && last ? encodeCursor(cursorKeyFor('newest', last), last.id, CURSOR_SCOPE) : null;

    return { items, nextCursor };
  }

  /**
   * Records a moderator's decision. `moderationDecisionInputSchema` (see
   * `@reviews/contracts`) makes `reason` a required-but-nullable key, since
   * an approval legitimately carries no reason — it does not by itself
   * enforce that a *rejection* carries one, so that check happens here,
   * before the repository is ever called: a 400 for a missing rejection
   * reason must never reach `ReviewsRepository.decide` and its conditional
   * update at all.
   *
   * Translates `ReviewNotAwaitingModerationError` into 409 — the review was
   * already decided, whether by an earlier call from this same moderator, a
   * different one, or (eventually) the automatic classifier this endpoint
   * exists to back up — and `ReviewNotFoundError` into 404 for a reviewId
   * that never matched any row. The repository tells these two apart
   * itself (see `ReviewsRepository.decide`'s doc comment); this method just
   * maps each to the response its own name promises, rather than folding
   * both into the same 409 the way a bare `updateMany.count === 0` would.
   *
   * `moderatorId` is the caller's own id (see `ModerationController#decide`,
   * which supplies it from `@CurrentUser()`) — carried through to
   * `ReviewsRepository.decide` unchanged so the decision's outbox event
   * records who made it. With hard-delete-and-cascade on `reviews`, that
   * event is the only place this fact survives.
   */
  async decide(reviewId: string, input: ModerationDecisionInput, moderatorId: string): Promise<ReviewDto> {
    if (input.decision === 'REJECTED' && !input.reason) {
      throw new BadRequestException('a reason is required to reject a review');
    }

    try {
      const review = await this.repository.decide({
        reviewId,
        decision: input.decision,
        reason: input.reason,
        moderatorId,
      });
      return toReviewDto(review);
    } catch (error) {
      if (error instanceof ReviewNotFoundError) {
        throw new NotFoundException('Review not found');
      }
      if (error instanceof ReviewNotAwaitingModerationError) {
        throw new ConflictException('review is not awaiting moderation');
      }
      throw error;
    }
  }
}
