import { ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  cacheKeys,
  paginatedSchema,
  reviewDtoSchema,
  TTL_REVIEW_LIST,
  type CreateReviewInput,
  type ReviewDto,
  type ReviewSort,
  type UpdateReviewInput,
} from '@reviews/contracts';
import type { Role } from '@reviews/db';
import type { z } from 'zod';
import { CacheService } from '../common/cache/cache.service.js';
import { decodeCursor, encodeCursor } from '../common/pagination/cursor.js';
import { toPublicReviewDto, toReviewDto } from './reviews.mapper.js';
import {
  cursorKeyFor,
  isUniqueReviewViolation,
  NotReviewAuthorError,
  ProductNotFoundError,
  ReviewNotFoundError,
  ReviewsRepository,
} from './reviews.repository.js';

export interface SubmitReviewCommand {
  productId: string;
  authorId: string;
  input: CreateReviewInput;
}

export interface ListReviewsQuery {
  productId: string;
  sort: ReviewSort;
  rating?: number;
  cursor?: string;
  limit: number;
}

// Derived from the shared contract rather than hand-restated — see
// products.service.ts's `productListSchema` for why: if `paginatedSchema`'s
// field names ever change, this type (and every call site that builds one)
// fails to compile instead of silently drifting from the contract.
export const reviewListSchema = paginatedSchema(reviewDtoSchema);
export type ListReviewsResult = z.infer<typeof reviewListSchema>;

@Injectable()
export class ReviewsService {
  private readonly logger = new Logger(ReviewsService.name);

  constructor(
    private readonly repository: ReviewsRepository,
    private readonly cache: CacheService,
  ) {}

  /**
   * The public review list for a product: `APPROVED` reviews only, in the
   * order `query.sort` names.
   *
   * The cursor's scope is the sort itself (prefixed to keep this
   * namespace distinct from other cursor producers, e.g. the product
   * list's `'products'` scope). A helpful-count of 3 means something
   * different from a rating of 3, so resuming a `sort=helpful` cursor
   * under `sort=newest` would silently return an arbitrary slice of the
   * list if `decodeCursor` didn't reject the mismatch outright — see
   * cursor.ts and this suite's "rejects a cursor from sort=newest replayed
   * against sort=helpful" case.
   *
   * Cache-aside covers only the first page — `query.cursor` absent — of a
   * given `(productId, sort, rating)` combination (design doc §7: deep
   * pages are rarely requested and would multiply invalidation work). The
   * key, `cacheKeys.reviewListFirstPage`, lives in `@reviews/contracts` so
   * Plan 2's aggregation worker deletes exactly what this method writes —
   * see that module's doc comment. Follows `ProductsService.getBySlug`'s
   * cache-aside shape exactly, including its `safeCacheGet`/`safeCacheSet`
   * guards: a Redis failure must degrade to a database read, never fail
   * the request.
   */
  async list(query: ListReviewsQuery): Promise<ListReviewsResult> {
    const scope = cursorScope(query.sort);
    const cursor = query.cursor ? decodeCursor(query.cursor, scope) : undefined;

    if (!cursor) {
      const key = cacheKeys.reviewListFirstPage(query.productId, query.sort, query.rating);
      const cached = await this.safeCacheGet<ListReviewsResult>(key);
      if (cached !== null) {
        return cached;
      }

      const result = await this.fetchPage(query, scope, cursor);
      await this.safeCacheSet(key, result, TTL_REVIEW_LIST);
      return result;
    }

    return this.fetchPage(query, scope, cursor);
  }

  private async fetchPage(
    query: ListReviewsQuery,
    scope: string,
    cursor: { key: string; id: string } | undefined,
  ): Promise<ListReviewsResult> {
    const { rows, hasMore } = await this.repository.listApproved({
      productId: query.productId,
      sort: query.sort,
      rating: query.rating,
      limit: query.limit,
      cursor,
    });

    const items = rows.map(toPublicReviewDto);
    const last = rows.at(-1);
    const nextCursor = hasMore && last ? encodeCursor(cursorKeyFor(query.sort, last), last.id, scope) : null;

    return { items, nextCursor };
  }

  /**
   * Submits a review for moderation: the row lands as `PENDING` and its
   * `review.submitted` domain event is recorded in the same transaction —
   * see `ReviewsRepository.submit`. This method's job is translating what
   * the repository throws into the right HTTP response; the repository
   * itself throws only plain errors, never `HttpException`s.
   */
  async submit(command: SubmitReviewCommand): Promise<ReviewDto> {
    const { productId, authorId, input } = command;

    try {
      const review = await this.repository.submit({
        productId,
        authorId,
        rating: input.rating,
        title: input.title,
        body: input.body,
      });
      return toReviewDto(review);
    } catch (error) {
      if (error instanceof ProductNotFoundError) {
        throw new NotFoundException('Product not found');
      }

      if (isUniqueReviewViolation(error)) {
        // The transaction that hit the unique-constraint violation has
        // already rolled back (taking its outbox insert with it — this is
        // the property the "writes no outbox event on conflict" test
        // pins down), so the existing review is re-read fresh here rather
        // than reused from any stale in-flight state.
        const existing = await this.repository.findByProductAndAuthor(productId, authorId);
        throw new ConflictException({
          statusCode: 409,
          message: 'You have already submitted a review for this product',
          reviewId: existing?.id,
        });
      }

      throw error;
    }
  }

  /**
   * Applies the author's patch — translates what `ReviewsRepository.update`
   * throws into the right HTTP response, the same split `submit` uses for
   * `ProductNotFoundError`. See that repository method's doc comment for
   * the transaction it runs and the event ordering it guarantees.
   */
  async update(reviewId: string, authorId: string, input: UpdateReviewInput): Promise<ReviewDto> {
    try {
      const review = await this.repository.update(reviewId, authorId, input);
      return toReviewDto(review);
    } catch (error) {
      if (error instanceof ReviewNotFoundError) {
        throw new NotFoundException('Review not found');
      }
      if (error instanceof NotReviewAuthorError) {
        // Deliberately the same 403 whether the caller is another customer
        // or a moderator — see NotReviewAuthorError's doc comment: editing
        // is author-only, with no role-based exception.
        throw new ForbiddenException('You may only edit your own review');
      }
      throw error;
    }
  }

  /**
   * Deletes `reviewId` on behalf of `callerId`/`callerRole` — the author, or
   * any `MODERATOR`. See `ReviewsRepository.remove`'s doc comment for why
   * this is a hard delete and what its lone outbox event carries.
   */
  async remove(reviewId: string, callerId: string, callerRole: Role): Promise<void> {
    try {
      await this.repository.remove(reviewId, callerId, callerRole);
    } catch (error) {
      if (error instanceof ReviewNotFoundError) {
        throw new NotFoundException('Review not found');
      }
      if (error instanceof NotReviewAuthorError) {
        throw new ForbiddenException('You may only delete your own review');
      }
      throw error;
    }
  }

  /**
   * Every review `authorId` has authored, in every status, including
   * `moderationReason` on rejected ones — the backing call for
   * `GET /me/reviews`. Uses `toReviewDto`, never `toPublicReviewDto`: this
   * is the one path where a caller is entitled to see their own
   * `moderationReason`, unlike the public `list` above, which always nulls
   * it. See reviews.mapper.ts for that contrast.
   */
  async listMine(authorId: string): Promise<ReviewDto[]> {
    const rows = await this.repository.listByAuthor(authorId);
    return rows.map(toReviewDto);
  }

  // Identical shape to ProductsService's private cache-aside guards — see
  // that class's doc comment on getBySlug for why both the read and the
  // write are caught rather than left to propagate: RedisModule sets
  // maxRetriesPerRequest: 1 so a hung Redis fails fast, but "fails fast"
  // still means it throws, and a cache is an optional accelerator that
  // must never turn a Redis blip into a 500 on this listing.
  private async safeCacheGet<T>(key: string): Promise<T | null> {
    try {
      return await this.cache.get<T>(key);
    } catch (error) {
      this.logCacheFailure('read', key, error);
      return null;
    }
  }

  private async safeCacheSet<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    try {
      await this.cache.set(key, value, ttlSeconds);
    } catch (error) {
      this.logCacheFailure('write', key, error);
    }
  }

  private logCacheFailure(operation: 'read' | 'write', key: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.logger.warn(`Cache ${operation} failed for "${key}", falling through to Postgres: ${message}`);
  }
}

/**
 * The cursor scope for a review list under `sort` — see cursor.ts for why
 * a cursor is scoped at all. Prefixed (rather than the bare sort name) so
 * this namespace can never collide with another feature's cursor scope,
 * e.g. the product list's `'products'` scope.
 *
 * Exported so a test can mint a cursor with a *valid, matching* scope but
 * a deliberately garbage key (see review-listing.integration.test.ts's
 * cursor-validation cases) without hardcoding this module's private
 * `'reviews:'` prefix as a second, drift-prone copy of the same string.
 */
export function cursorScope(sort: ReviewSort): string {
  return `reviews:${sort}`;
}
