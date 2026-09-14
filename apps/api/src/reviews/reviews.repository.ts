import { Injectable } from '@nestjs/common';
import { EVENT_TYPES, type ReviewSort } from '@reviews/contracts';
import { Prisma, writeOutboxEvent, type Review } from '@reviews/db';
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
      const value = new Date(key);
      return { OR: [{ createdAt: isDesc ? { lt: value } : { gt: value } }, { createdAt: value, id: { lt: id } }] };
    }
    case 'helpfulCount': {
      const value = Number(key);
      return {
        OR: [{ helpfulCount: isDesc ? { lt: value } : { gt: value } }, { helpfulCount: value, id: { lt: id } }],
      };
    }
    case 'rating': {
      const value = Number(key);
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
}

/** True when `error` is the Prisma unique-constraint violation on `reviews`. */
export function isUniqueReviewViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
