import { BadRequestException, Injectable } from '@nestjs/common';
import { EVENT_TYPES, type ReviewSort, type VoteValue } from '@reviews/contracts';
import { Prisma, writeOutboxEvent, type Review, type ReviewStatus, type Role } from '@reviews/db';
import { PrismaService } from '../common/prisma/prisma.service.js';

/** A review row joined with the author fields the DTO exposes. */
export type ReviewWithAuthor = Review & { author: { id: string; displayName: string } };

/** The Prisma column a public sort order paginates on — see {@link SORTS}. */
type SortColumn = 'helpfulCount' | 'createdAt' | 'rating';

interface SortDefinition {
  /** Row id is always the final `desc` tie-breaker — see {@link SORTS}. */
  orderBy: Prisma.ReviewOrderByWithRelationInput[];
  column: SortColumn;
  direction: 'asc' | 'desc';
}

/**
 * One entry per public sort order, driving three things at once: the
 * Prisma `orderBy` array, which column keyset pagination resumes from, and
 * (via `direction`) which side of that column the next page's `WHERE`
 * clause compares against. Adding a sort later is one entry here, not a
 * new branch in `listApproved`, {@link cursorKeyFor}, and the cursor
 * `WHERE` builder below.
 *
 * `helpfulCount` and `rating` are not unique across a product's reviews —
 * several reviews commonly tie — so every entry appends `{ id: 'desc' }`
 * as a final tie-breaker, and the cursor's `WHERE` clause (see
 * `cursorWhere`) compares `(column, id)` as a pair rather than `column`
 * alone. A cursor built from the column alone would silently skip or
 * repeat rows inside a tied group; see
 * test/review-listing.integration.test.ts's "pages through helpful-sorted
 * reviews without duplicates or gaps".
 *
 * The tie-breaker is `id` alone, not `id` plus a third column — `id` by
 * itself already makes the ordering total (ids are unique), so a
 * secondary column adds a cursor field for no ordering benefit. Within a
 * tie, rows happen to display newest-first only because ids in this
 * schema are UUIDv7, which are time-ordered; that's a side effect of the
 * id scheme, not something this table encodes. If `Review.id` ever moves
 * off v7 (e.g. to v4), pagination stays correct — `id` is still unique —
 * but the display order of tied rows would stop tracking recency.
 */
const SORTS: Record<ReviewSort, SortDefinition> = {
  helpful: { orderBy: [{ helpfulCount: 'desc' }, { id: 'desc' }], column: 'helpfulCount', direction: 'desc' },
  newest: { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], column: 'createdAt', direction: 'desc' },
  rating_desc: { orderBy: [{ rating: 'desc' }, { id: 'desc' }], column: 'rating', direction: 'desc' },
  rating_asc: { orderBy: [{ rating: 'asc' }, { id: 'desc' }], column: 'rating', direction: 'asc' },
};

/** The cursor key value for `row` under `sort` — the column `SORTS[sort]` names. */
export function cursorKeyFor(sort: ReviewSort, row: Review): string | number {
  const value = row[SORTS[sort].column];
  return value instanceof Date ? value.toISOString() : value;
}

/**
 * Parses a cursor key as the number a `helpfulCount`/`rating` cursor must
 * carry. `decodeCursor` only checks that the key is a non-empty string —
 * scope is what it validates — so a cursor with a correct, matching scope
 * but a garbage key (`"abc"`) still has to be rejected here, with the same
 * `BadRequestException` a scope mismatch gets. Left unchecked, `Number()`
 * would hand Prisma a `NaN` bound, which reaches Postgres, misses every
 * known-error branch in the global exception filter, and 500s — for a
 * public endpoint taking attacker-controlled query-string input, that is
 * exactly the "arbitrary server error instead of a clean client error"
 * outcome the scope check exists to avoid.
 */
function parseCursorNumber(key: string): number {
  const value = Number(key);
  if (Number.isNaN(value)) {
    throw new BadRequestException('invalid cursor');
  }
  return value;
}

/** As {@link parseCursorNumber}, for a `createdAt` cursor's date key. */
function parseCursorDate(key: string): Date {
  const value = new Date(key);
  if (Number.isNaN(value.getTime())) {
    throw new BadRequestException('invalid cursor');
  }
  return value;
}

/**
 * Builds the keyset `WHERE` fragment for resuming `sort` after `(key, id)`:
 * `(column, id) < (key, id)` for a `desc` sort, `column > key OR (column =
 * key AND id < id)` for `rating_asc` — the tie-breaker id direction never
 * flips, only the primary column's comparison operator does.
 *
 * Written as a switch over `column`'s three possible types (not over the
 * four sort values — `rating_desc` and `rating_asc` share this same
 * `'rating'` branch) because Prisma's `WhereInput` fields aren't uniform
 * enough for one fully generic dynamic-key object without an `any`.
 */
function cursorWhere(sort: ReviewSort, key: string, id: string): Prisma.ReviewWhereInput {
  const { column, direction } = SORTS[sort];
  const isDesc = direction === 'desc';

  switch (column) {
    case 'createdAt': {
      const value = parseCursorDate(key);
      return { OR: [{ createdAt: isDesc ? { lt: value } : { gt: value } }, { createdAt: value, id: { lt: id } }] };
    }
    case 'helpfulCount': {
      const value = parseCursorNumber(key);
      return {
        OR: [{ helpfulCount: isDesc ? { lt: value } : { gt: value } }, { helpfulCount: value, id: { lt: id } }],
      };
    }
    case 'rating': {
      const value = parseCursorNumber(key);
      return { OR: [{ rating: isDesc ? { lt: value } : { gt: value } }, { rating: value, id: { lt: id } }] };
    }
  }
}

export interface ListApprovedReviewsParams {
  productId: string;
  sort: ReviewSort;
  rating?: number;
  limit: number;
  cursor?: { key: string; id: string };
}

export interface ListApprovedReviewsPage {
  /** At most `limit` rows — the lookahead row used to compute `hasMore` is trimmed off. */
  rows: ReviewWithAuthor[];
  hasMore: boolean;
}

export interface SubmitReviewParams {
  productId: string;
  authorId: string;
  rating: number;
  title: string;
  body: string;
}

/** The two denormalised vote counters on a `reviews` row. */
export interface VoteCounts {
  helpfulCount: number;
  notHelpfulCount: number;
}

/**
 * Thrown from inside {@link ReviewsRepository.submit}'s transaction when
 * `productId` doesn't reference a real product. Deliberately a plain
 * `Error`, not a NestJS `HttpException`: this repository owns every Prisma
 * call and nothing else, and translating "no such product" into a 404 is
 * `ReviewsService`'s job, not this layer's — see reviews.service.ts.
 */
export class ProductNotFoundError extends Error {
  constructor(public readonly productId: string) {
    super(`Product ${productId} not found`);
    this.name = 'ProductNotFoundError';
  }
}

/**
 * Thrown from inside {@link ReviewsRepository.castVote} when `reviewId`
 * doesn't reference an `APPROVED` review — either because no such review
 * exists at all, or because it exists but hasn't cleared moderation yet.
 * Both collapse onto the same error (and, in `VotesService`, the same 404):
 * a review that isn't publicly addressable must not be distinguishable from
 * one that doesn't exist, or the response itself would leak which pending
 * reviews are real.
 */
export class ReviewNotVotableError extends Error {
  constructor(public readonly reviewId: string) {
    super(`Review ${reviewId} is not votable`);
    this.name = 'ReviewNotVotableError';
  }
}

/**
 * Thrown from inside {@link ReviewsRepository.castVote} when the voter is
 * the review's own author. Checked only after the review is confirmed to
 * exist and be `APPROVED` — see {@link ReviewNotVotableError}'s doc comment
 * for why that ordering matters: checking self-vote first would answer 403
 * for a non-approved review the caller happens to own, confirming its
 * existence through the status code alone.
 */
export class SelfVoteError extends Error {
  constructor(public readonly reviewId: string) {
    super(`User cannot vote on their own review ${reviewId}`);
    this.name = 'SelfVoteError';
  }
}

/**
 * Thrown from inside {@link ReviewsRepository.update} and
 * {@link ReviewsRepository.remove} when `reviewId` doesn't match any row.
 * Deliberately a plain `Error`, not a `NotFoundException` — see
 * `ProductNotFoundError`'s doc comment for why this layer never throws a
 * NestJS type.
 */
export class ReviewNotFoundError extends Error {
  constructor(public readonly reviewId: string) {
    super(`Review ${reviewId} not found`);
    this.name = 'ReviewNotFoundError';
  }
}

/**
 * Thrown from inside {@link ReviewsRepository.update} when the caller isn't
 * the review's author, and from {@link ReviewsRepository.remove} when the
 * caller is neither the author nor a `MODERATOR`.
 *
 * `update` has no role escape hatch at all — it compares `authorId` against
 * the caller and stops there, full stop, regardless of what role the caller
 * holds. That is deliberate: rewriting a customer's words is not a
 * moderation decision (unlike deleting one, which `remove` does allow a
 * `MODERATOR` to do), so a moderator hitting this error is not an accident
 * of the ownership check being reused for both endpoints — there is no
 * separate role branch in `update` that a future change could widen by
 * mistake.
 */
export class NotReviewAuthorError extends Error {
  constructor(public readonly reviewId: string) {
    super(`User is not the author of review ${reviewId}`);
    this.name = 'NotReviewAuthorError';
  }
}

export interface UpdateReviewPatch {
  rating?: number;
  title?: string;
  body?: string;
}

export interface ModerationQueueParams {
  status: ReviewStatus;
  limit: number;
  cursor?: { key: string; id: string };
}

export interface ModerationQueuePage {
  /** At most `limit` rows — see {@link ListApprovedReviewsPage} for why. */
  rows: ReviewWithAuthor[];
  hasMore: boolean;
}

export interface DecideModerationParams {
  reviewId: string;
  decision: 'APPROVED' | 'REJECTED';
  reason: string | null;
}

/**
 * Thrown from inside {@link ReviewsRepository.decide} when `reviewId`
 * doesn't currently match a `PENDING` or `FLAGGED` row — either no such
 * review exists at all, or it does but has already been decided (by this
 * call or a concurrent one). Both collapse onto the same
 * {@link ModerationService}-level 409: from the caller's point of view, "no
 * longer awaiting moderation" is the one fact that matters, not which of
 * the two reasons produced it.
 */
export class ReviewNotAwaitingModerationError extends Error {
  constructor(public readonly reviewId: string) {
    super(`Review ${reviewId} is not awaiting moderation`);
    this.name = 'ReviewNotAwaitingModerationError';
  }
}

/**
 * Owns every Prisma call the reviews-submission flow makes.
 * `ReviewsService` and `ReviewsController` never see a Prisma type.
 *
 * Atomicity lives at the level of one method's own `this.prisma.$transaction`
 * call, not at the level of this class or of `ReviewsService`: there is no
 * shared `tx` handle a caller can thread across two separate repository
 * calls, so `service.methodA()` followed by `service.methodB()` never
 * shares a transaction no matter how they're composed above this layer. If
 * a future change needs two writes to succeed or fail together — the same
 * property `submit` relies on for the review row and its outbox event —
 * both writes belong inside one repository method, in one `$transaction`
 * call, the way `submit` does it below. Splitting them across two
 * repository methods and calling both from the service looks identical at
 * the type level but silently gives up atomicity.
 */
@Injectable()
export class ReviewsRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Creates a `PENDING` review and records its `review.submitted` outbox
   * event in one transaction — the architectural point of this task. See
   * `packages/db/src/outbox.ts` for why the event write has to happen
   * inside this same transaction rather than after it.
   *
   * The product-existence check runs first, *inside* this transaction,
   * rather than as a separate query before it: a standalone pre-check
   * would leave a window between "product confirmed to exist" and "review
   * inserted" in which nothing guarantees the answer is still true. Doing
   * it as the first statement of the one transaction that also performs
   * the insert closes that window instead of merely narrowing it.
   *
   * The duplicate-submission case is not checked here at all — it rides
   * on the database's `UNIQUE(product_id, author_id)` constraint on
   * `reviews`. `tx.review.create` throws Prisma's `P2002` when it fires,
   * which aborts the transaction (rolling back the outbox insert with it)
   * and propagates out of `submit` unchanged; `ReviewsService.submit`
   * catches it and re-reads the existing review to build the 409 body.
   */
  async submit(params: SubmitReviewParams): Promise<ReviewWithAuthor> {
    const { productId, authorId, rating, title, body } = params;

    return this.prisma.$transaction(async (tx) => {
      const product = await tx.product.findUnique({ where: { id: productId }, select: { id: true } });
      if (!product) {
        throw new ProductNotFoundError(productId);
      }

      const purchaseCount = await tx.purchase.count({ where: { userId: authorId, productId } });
      const verifiedPurchase = purchaseCount > 0;

      const review = await tx.review.create({
        data: { productId, authorId, rating, title, body, verifiedPurchase, status: 'PENDING' },
        include: { author: { select: { id: true, displayName: true } } },
      });

      await writeOutboxEvent(tx, {
        eventType: EVENT_TYPES.REVIEW_SUBMITTED,
        aggregateId: review.id,
        payload: { reviewId: review.id, productId, authorId, rating, title, body, verifiedPurchase },
      });

      return review;
    });
  }

  /**
   * Re-reads the review a duplicate submission collided with, so the 409
   * response can include its id. Runs against the plain client, not a
   * transaction handle: by the time a caller needs this, the transaction
   * that threw `P2002` has already been rolled back and its `tx` handle is
   * no longer usable.
   */
  async findByProductAndAuthor(productId: string, authorId: string): Promise<ReviewWithAuthor | null> {
    return this.prisma.review.findUnique({
      where: { productId_authorId: { productId, authorId } },
      include: { author: { select: { id: true, displayName: true } } },
    });
  }

  /**
   * Keyset pagination over a product's `APPROVED` reviews, sorted per
   * {@link SORTS}. Fetches `limit + 1` rows so the caller can tell whether
   * a next page exists without a second `COUNT` query — the extra row is
   * trimmed here before the rows are returned, the same pattern
   * `ProductsRepository.list` uses.
   */
  async listApproved(params: ListApprovedReviewsParams): Promise<ListApprovedReviewsPage> {
    const { productId, sort, rating, limit, cursor } = params;

    const conditions: Prisma.ReviewWhereInput[] = [{ productId, status: 'APPROVED' }];
    if (rating !== undefined) {
      conditions.push({ rating });
    }
    if (cursor) {
      conditions.push(cursorWhere(sort, cursor.key, cursor.id));
    }

    const rows = await this.prisma.review.findMany({
      where: { AND: conditions },
      orderBy: SORTS[sort].orderBy,
      take: limit + 1,
      include: { author: { select: { id: true, displayName: true } } },
    });

    const hasMore = rows.length > limit;
    return { rows: hasMore ? rows.slice(0, limit) : rows, hasMore };
  }

  /**
   * Casts (or changes) `userId`'s vote on `reviewId`, then returns the
   * review's recomputed counters.
   *
   * One transaction does four things in order: lock the review row and, in
   * that same statement, read the fields needed to confirm it's `APPROVED`
   * (else {@link ReviewNotVotableError}) and that the voter isn't the
   * author (else {@link SelfVoteError}); upsert the `review_votes` row
   * keyed by `(reviewId, userId)` — the table's own primary key is what
   * makes this idempotent rather than cumulative, a repeat or changed vote
   * replaces the one row instead of adding another — and finally recompute
   * both counters from that table.
   *
   * The status/author check reads under the same `FOR UPDATE` lock the
   * vote write relies on (see {@link lockReviewRow}), not from a separate,
   * unlocked `findUnique` beforehand: a plain read followed by a later lock
   * would leave a window between the two in which a moderator's concurrent
   * rejection could commit, so the vote proceeds against a review this
   * transaction never actually confirmed was still `APPROVED`. Locking
   * first and reading the same locked row closes that window — the two
   * checks are in-process and add no I/O, so folding them into the locking
   * statement costs nothing.
   *
   * The counters are recomputed, not incremented, and the recompute runs
   * inside this same transaction rather than after it. Concurrent votes on
   * the same review serialise on the `FOR UPDATE` lock taken up front, so
   * every recompute that follows sees a snapshot that already includes
   * every vote whose transaction committed first. An `increment` has no
   * such serialisation point: two concurrent transactions can both read the
   * pre-vote count and each write back their own +1, silently losing one of
   * the two votes. See test/votes.integration.test.ts's ten-concurrent-
   * voters case.
   *
   * The lock is taken before the upsert, not after — see
   * {@link lockReviewRow}'s doc comment for why acquiring it afterward
   * deadlocks under concurrency instead of merely serialising.
   */
  async castVote(reviewId: string, userId: string, value: VoteValue): Promise<VoteCounts> {
    return this.prisma.$transaction(async (tx) => {
      const review = await lockReviewRow(tx, reviewId);
      if (!review || review.status !== 'APPROVED') {
        throw new ReviewNotVotableError(reviewId);
      }
      if (review.authorId === userId) {
        throw new SelfVoteError(reviewId);
      }

      await tx.reviewVote.upsert({
        where: { reviewId_userId: { reviewId, userId } },
        create: { reviewId, userId, value },
        update: { value },
      });

      return recomputeVoteCounts(tx, reviewId);
    });
  }

  /**
   * Removes `userId`'s vote on `reviewId`, if one exists, then recomputes
   * the review's counters in the same transaction — see {@link castVote}
   * for why the recompute has to be a recompute, why it has to share the
   * vote write's transaction, and why the row lock has to be acquired
   * before that write.
   *
   * Deliberately does not check that the review exists or is `APPROVED`
   * first: removing a vote that is already absent (or was cast against a
   * review that has since been un-approved) has still succeeded from the
   * caller's point of view, which is why `VotesController#remove` answers
   * `204` unconditionally rather than surfacing a 404 here. `deleteMany`
   * (not `delete`) is what makes the "no such vote" case a no-op instead of
   * Prisma's `P2025`.
   */
  async removeVote(reviewId: string, userId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      // The locked row's fields aren't needed here — removeVote never
      // checks the review's status or author (see this method's own doc
      // comment above) — so the return value is discarded.
      await lockReviewRow(tx, reviewId);
      await tx.reviewVote.deleteMany({ where: { reviewId, userId } });
      await recomputeVoteCounts(tx, reviewId);
    });
  }

  /**
   * Applies `authorId`'s patch to `reviewId` in one transaction: locks the
   * row first (see {@link lockReviewRow}), rejects unless `authorId` is the
   * review's own author (see {@link NotReviewAuthorError}'s doc comment for
   * why there is no role-based bypass here), then always returns the review
   * to `PENDING` — an edit is a resubmission for moderation, whatever its
   * previous status was — clearing `publishedAt` and the now-stale
   * `moderationReason`.
   *
   * If the locked row was `APPROVED`, a `review.unpublished` event is
   * written *before* the patch is applied and `review.submitted` is
   * written, in that order. Both events land in this same transaction, but
   * the ordering between them is still what the brief calls load-bearing:
   * a consumer recomputing a product's rating from approved reviews reads
   * the outbox in row-id order, and `writeOutboxEvent`'s ids are
   * monotonic within one transaction (see its own doc comment on
   * `eventId`/insert order), so writing `REVIEW_UNPUBLISHED` first is what
   * guarantees the removal is visible to that consumer no later than the
   * resubmission — never a window where the old, no-longer-displayed text
   * is still counted. See test/review-management.integration.test.ts's
   * "unpublishes and resubmits when an approved review is edited".
   *
   * A row that was `PENDING`, `REJECTED`, or `FLAGGED` was never on public
   * display, so no `review.unpublished` fires for those — only the
   * `review.submitted` resubmission.
   */
  async update(reviewId: string, authorId: string, patch: UpdateReviewPatch): Promise<ReviewWithAuthor> {
    return this.prisma.$transaction(async (tx) => {
      const locked = await lockReviewRow(tx, reviewId);
      if (!locked) {
        throw new ReviewNotFoundError(reviewId);
      }
      if (locked.authorId !== authorId) {
        throw new NotReviewAuthorError(reviewId);
      }

      if (locked.status === 'APPROVED') {
        await writeOutboxEvent(tx, {
          eventType: EVENT_TYPES.REVIEW_UNPUBLISHED,
          aggregateId: reviewId,
          payload: { reviewId, productId: locked.productId },
        });
      }

      const updated = await tx.review.update({
        where: { id: reviewId },
        data: {
          rating: patch.rating,
          title: patch.title,
          body: patch.body,
          status: 'PENDING',
          publishedAt: null,
          moderationReason: null,
        },
        include: { author: { select: { id: true, displayName: true } } },
      });

      await writeOutboxEvent(tx, {
        eventType: EVENT_TYPES.REVIEW_SUBMITTED,
        aggregateId: reviewId,
        payload: {
          reviewId,
          productId: locked.productId,
          authorId,
          rating: updated.rating,
          title: updated.title,
          body: updated.body,
          verifiedPurchase: updated.verifiedPurchase,
        },
      });

      return updated;
    });
  }

  /**
   * Hard-deletes `reviewId` in one transaction: locks the row first,
   * rejects unless `callerId` is the author or `callerRole` is
   * `MODERATOR`, deletes it — `review_votes` rows cascade via the FK's
   * `onDelete: Cascade` (see schema.prisma), so no separate vote cleanup is
   * needed here — and records `review.unpublished`.
   *
   * The event payload carries only `reviewId`/`productId`
   * (`reviewUnpublishedPayloadSchema`'s full shape): the row is gone by the
   * time the projection consumes this event, so there is nothing left to
   * read a rating/title/body off of, and the projection recomputes the
   * product's rating from source (the surviving `APPROVED` reviews) rather
   * than needing this payload to carry more.
   *
   * Retaining a moderation audit trail after deletion would argue for a
   * soft delete instead (a `deletedAt` column and a filter everywhere else
   * already assumes "row exists" means "not deleted") — noted as a
   * possible future direction, not implemented here.
   */
  async remove(reviewId: string, callerId: string, callerRole: Role): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const locked = await lockReviewRow(tx, reviewId);
      if (!locked) {
        throw new ReviewNotFoundError(reviewId);
      }
      if (locked.authorId !== callerId && callerRole !== 'MODERATOR') {
        throw new NotReviewAuthorError(reviewId);
      }

      await tx.review.delete({ where: { id: reviewId } });

      await writeOutboxEvent(tx, {
        eventType: EVENT_TYPES.REVIEW_UNPUBLISHED,
        aggregateId: reviewId,
        payload: { reviewId, productId: locked.productId },
      });
    });
  }

  /**
   * Every review `authorId` has written, in every status, newest first —
   * the backing query for `GET /me/reviews`. No `productId` filter and no
   * `status: 'APPROVED'` filter: unlike {@link listApproved}, this is the
   * author reading their own work, so a `PENDING`/`REJECTED`/`FLAGGED` row
   * (and, on a rejected one, its `moderationReason`) is exactly what should
   * come back — see reviews.mapper.ts's `toReviewDto` vs `toPublicReviewDto`
   * for the two paths this deliberately keeps apart.
   */
  async listByAuthor(authorId: string): Promise<ReviewWithAuthor[]> {
    return this.prisma.review.findMany({
      where: { authorId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: { author: { select: { id: true, displayName: true } } },
    });
  }

  /**
   * Keyset pagination over every review in `status`, newest first — the
   * backing query for a moderator's queue. Reuses `SORTS.newest`'s
   * `orderBy` and `cursorWhere('newest', …)`'s `WHERE` fragment rather than
   * defining a second copy of "paginate by `(createdAt, id)` descending":
   * a moderation queue has exactly one sort order, so there is no reason
   * for it to duplicate the machinery {@link listApproved} already built
   * to support four.
   *
   * Unlike `listApproved`, there is no `status: 'APPROVED'` floor here —
   * `params.status` names whichever status the moderator is browsing
   * (`FLAGGED` by default, or e.g. `PENDING`), and the full row (including
   * `body`) comes back: a moderator cannot judge an excerpt, so this is
   * the one listing in the codebase that doesn't need `toPublicReviewDto`'s
   * trimming.
   */
  async listQueue(params: ModerationQueueParams): Promise<ModerationQueuePage> {
    const { status, limit, cursor } = params;

    const conditions: Prisma.ReviewWhereInput[] = [{ status }];
    if (cursor) {
      conditions.push(cursorWhere('newest', cursor.key, cursor.id));
    }

    const rows = await this.prisma.review.findMany({
      where: { AND: conditions },
      orderBy: SORTS.newest.orderBy,
      take: limit + 1,
      include: { author: { select: { id: true, displayName: true } } },
    });

    const hasMore = rows.length > limit;
    return { rows: hasMore ? rows.slice(0, limit) : rows, hasMore };
  }

  /**
   * Records a moderator's decision on `reviewId` as one conditional update
   * inside one transaction: `updateMany` predicated on the row still being
   * `PENDING` or `FLAGGED`, not `update` by id alone. That predicate *is*
   * the concurrency guard — there is no separate `lockReviewRow` call here,
   * unlike `castVote`/`update`/`remove` above. Those methods need a lock
   * because they read a value (vote counts, ownership) that a concurrent
   * writer could change out from under an unlocked read-then-write; this
   * method's only question — "is the row still awaiting moderation?" — is
   * exactly what the `WHERE status IN (...)` clause already answers
   * atomically. Postgres serialises two concurrent `updateMany` calls
   * against the same row via ordinary row-level locking: whichever commits
   * first wins, and the second re-evaluates the same `WHERE` under its own
   * snapshot and matches zero rows, because the first one already moved the
   * status out of `PENDING`/`FLAGGED`. `updated.count === 0` is exactly
   * that "someone else already decided this" case — see
   * {@link ReviewNotAwaitingModerationError} — folding a manual lock in on
   * top would add a blocking round trip the predicate already makes
   * unnecessary.
   *
   * Approving sets `publishedAt` to now; rejecting clears it (a `FLAGGED`
   * row is never itself published, but a `PENDING` one it was reachable
   * from never was either, so `null` is correct either way). The outbox
   * event — `review.approved` or `review.rejected` — is written only after
   * `updateMany` confirms the transition actually happened, inside the same
   * transaction: a conflict throws before `writeOutboxEvent` is ever
   * called, so the transaction rolls back with no event and no state
   * change, matching the "409, no outbox row" case load-bearing to this
   * task.
   */
  async decide(params: DecideModerationParams): Promise<ReviewWithAuthor> {
    const { reviewId, decision, reason } = params;

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.review.updateMany({
        where: { id: reviewId, status: { in: ['PENDING', 'FLAGGED'] } },
        data: {
          status: decision,
          moderationReason: reason,
          publishedAt: decision === 'APPROVED' ? new Date() : null,
        },
      });
      if (updated.count === 0) {
        throw new ReviewNotAwaitingModerationError(reviewId);
      }

      const review = await tx.review.findUniqueOrThrow({
        where: { id: reviewId },
        include: { author: { select: { id: true, displayName: true } } },
      });

      await writeOutboxEvent(tx, {
        eventType: decision === 'APPROVED' ? EVENT_TYPES.REVIEW_APPROVED : EVENT_TYPES.REVIEW_REJECTED,
        aggregateId: reviewId,
        payload: { reviewId, productId: review.productId, status: decision, moderationReason: reason },
      });

      return review;
    });
  }
}

/** The `reviews` fields {@link lockReviewRow} reads from behind its lock. */
interface LockedReview {
  authorId: string;
  productId: string;
  status: ReviewStatus;
}

/**
 * Takes an exclusive row lock on `reviews` for `reviewId` and, in that same
 * statement, reads back its author, product, and status — as its own
 * leading statement, before {@link ReviewsRepository.castVote},
 * {@link ReviewsRepository.removeVote}, {@link ReviewsRepository.update}, or
 * {@link ReviewsRepository.remove} writes anywhere else. Returns `null` if
 * `reviewId` doesn't match any row.
 *
 * Reading `author_id`/`product_id`/`status` here rather than via a separate
 * `findUnique` costs nothing extra — same statement, same round trip — and
 * is what lets `castVote` make its APPROVED/self-vote checks (and `update`/
 * `remove` their author/moderator checks) against a row they already hold
 * the lock on, closing the race a preceding unlocked read would leave open
 * against a concurrent moderation decision. `removeVote` also calls this
 * but has no checks of its own to make, so it discards the return value.
 *
 * Lock mode is `FOR UPDATE`, not the weaker `FOR NO KEY UPDATE` that would
 * also suffice for mutual exclusion among voters (self-conflicting, same as
 * `FOR UPDATE`, but — unlike `FOR UPDATE` — compatible with the `FOR KEY
 * SHARE` a referencing insert takes; see below). `FOR UPDATE` was kept
 * because `review_votes` is, today, the only table with a foreign key to
 * `reviews`, so there's no other concurrent locker for the stronger mode to
 * needlessly block. If a second table ever gains a FK to `reviews`, revisit
 * this: `FOR NO KEY UPDATE` would stop voting from blocking that table's
 * concurrent inserts for no reason.
 *
 * This has to run *before* the `review_votes` write, not after it — the
 * ordering matters and was found the hard way. `review_votes.review_id` has
 * a foreign key to `reviews.id`, and Postgres enforces that by implicitly
 * taking a `FOR KEY SHARE` lock on the referenced `reviews` row for the
 * duration of any transaction that inserts a referencing `review_votes`
 * row. `FOR KEY SHARE` locks from different transactions are mutually
 * compatible — many concurrent voters' upserts can all hold one on the same
 * review at once. If the exclusive `FOR UPDATE` lock were requested
 * *after* the upsert (as an original version of this code did), every one
 * of ten concurrent voters would already be holding that shared lock by the
 * time it tried to upgrade to exclusive, and an upgrade can't proceed until
 * every other shared holder releases — so all ten are waiting on each
 * other and Postgres reports `deadlock detected` (error `40P01`). Note this
 * is a *different* lock-mode conflict from the one `FOR UPDATE` itself
 * would have with `FOR KEY SHARE` even without an upgrade: `FOR NO KEY
 * UPDATE` doesn't conflict with `FOR KEY SHARE` at all, so a version of
 * this function using that weaker mode from the start would never have
 * deadlocked here regardless of ordering — it's specifically the request
 * for `FOR UPDATE`, and specifically requesting it *after* already holding
 * the shared lock, that produces the upgrade deadlock. Acquiring the
 * exclusive lock first avoids the shared lock ever being held by more than
 * one transaction at a time: whichever transaction gets here first wins the
 * lock outright, and every other transaction blocks cleanly on this
 * statement, never reaching its own upsert (and thus never taking the
 * shared FK lock) until the row is free.
 *
 * A `reviewId` that matches no row locks nothing and returns `null` —
 * relied on by `removeVote`, which never checks the review exists first.
 */
async function lockReviewRow(tx: Prisma.TransactionClient, reviewId: string): Promise<LockedReview | null> {
  const rows = await tx.$queryRaw<Array<{ author_id: string; product_id: string; status: ReviewStatus }>>`
    SELECT author_id, product_id, status FROM reviews WHERE id = ${reviewId}::uuid FOR UPDATE
  `;
  const row = rows[0];
  return row ? { authorId: row.author_id, productId: row.product_id, status: row.status } : null;
}

/**
 * Recomputes `reviewId`'s `helpful_count`/`not_helpful_count` from
 * `review_votes` and writes both back in one statement — the SQL from this
 * task's brief, run as a raw query because Prisma's query builder has no
 * portable way to express "set a column to an aggregate computed from a
 * different table" in a single UPDATE. Runs against `tx`, never against the
 * plain client, so it always executes inside the same transaction as
 * {@link lockReviewRow} and the vote write that precede it in
 * {@link ReviewsRepository.castVote} and {@link ReviewsRepository.removeVote}.
 *
 * Callers must have already called {@link lockReviewRow} for this exact
 * `reviewId` earlier in the same transaction. That's what makes a single
 * `UPDATE ... FROM` statement here safe: because this transaction already
 * holds the exclusive lock (acquired via its own leading statement, before
 * any write to `review_votes`), this `UPDATE` never itself has to wait — it
 * runs immediately, taking a fresh READ COMMITTED snapshot at that moment,
 * which correctly includes every vote already committed by every other
 * transaction that held the lock earlier and has since released it. Only a
 * statement that *itself* blocks on a row lock is at risk of the stale-read
 * gotcha this comment used to describe (Postgres's docs, "13.2.1. Read
 * Committed Isolation Level": a blocked, re-evaluated statement "does not
 * see effects of [concurrent] commands on other rows in the database") —
 * that risk was reproduced directly by an earlier version of this code that
 * combined the lock and the aggregate into one statement and landed ten
 * concurrent voters on `helpfulCount: 1`, not 10. See
 * test/votes.integration.test.ts's ten-concurrent-voters case.
 *
 * An `UPDATE` against a `reviewId` that doesn't match any row is a harmless
 * no-op, not an error — relied on by `removeVote`, which never checks the
 * review exists before calling this.
 */
async function recomputeVoteCounts(tx: Prisma.TransactionClient, reviewId: string): Promise<VoteCounts> {
  // Postgres has no implicit uuid = text comparison, and Prisma's tagged
  // template substitutes every interpolated value as text by default — every
  // occurrence of reviewId below needs the explicit ::uuid cast, or this
  // fails with "operator does not exist: uuid = text" against real Postgres.
  await tx.$executeRaw`
    UPDATE reviews r SET
      helpful_count     = v.helpful,
      not_helpful_count = v.not_helpful
    FROM (
      SELECT
        count(*) FILTER (WHERE value = 'HELPFUL')     AS helpful,
        count(*) FILTER (WHERE value = 'NOT_HELPFUL') AS not_helpful
      FROM review_votes WHERE review_id = ${reviewId}::uuid
    ) v
    WHERE r.id = ${reviewId}::uuid
  `;

  const updated = await tx.review.findUnique({
    where: { id: reviewId },
    select: { helpfulCount: true, notHelpfulCount: true },
  });

  return { helpfulCount: updated?.helpfulCount ?? 0, notHelpfulCount: updated?.notHelpfulCount ?? 0 };
}

/** True when `error` is the Prisma unique-constraint violation on `reviews`. */
export function isUniqueReviewViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
