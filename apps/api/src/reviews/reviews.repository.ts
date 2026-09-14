import { Injectable } from '@nestjs/common';
import { EVENT_TYPES } from '@reviews/contracts';
import { Prisma, writeOutboxEvent, type Review } from '@reviews/db';
import { PrismaService } from '../common/prisma/prisma.service.js';

/** A review row joined with the author fields the DTO exposes. */
export type ReviewWithAuthor = Review & { author: { id: string; displayName: string } };

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
}

/** True when `error` is the Prisma unique-constraint violation on `reviews`. */
export function isUniqueReviewViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
