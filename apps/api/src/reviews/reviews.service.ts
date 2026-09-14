import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { paginatedSchema, reviewDtoSchema, type CreateReviewInput, type ReviewDto, type ReviewSort } from '@reviews/contracts';
import type { z } from 'zod';
import { decodeCursor, encodeCursor } from '../common/pagination/cursor.js';
import { toPublicReviewDto, toReviewDto } from './reviews.mapper.js';
import {
  cursorKeyFor,
  isUniqueReviewViolation,
  ProductNotFoundError,
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
  constructor(private readonly repository: ReviewsRepository) {}

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
   */
  async list(query: ListReviewsQuery): Promise<ListReviewsResult> {
    const scope = cursorScope(query.sort);
    const cursor = query.cursor ? decodeCursor(query.cursor, scope) : undefined;

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
}

/**
 * The cursor scope for a review list under `sort` — see cursor.ts for why
 * a cursor is scoped at all. Prefixed (rather than the bare sort name) so
 * this namespace can never collide with another feature's cursor scope,
 * e.g. the product list's `'products'` scope.
 */
function cursorScope(sort: ReviewSort): string {
  return `reviews:${sort}`;
}
