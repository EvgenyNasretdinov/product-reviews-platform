import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { CreateReviewInput, ReviewDto } from '@reviews/contracts';
import { toReviewDto } from './reviews.mapper.js';
import { isUniqueReviewViolation, ProductNotFoundError, ReviewsRepository } from './reviews.repository.js';

export interface SubmitReviewCommand {
  productId: string;
  authorId: string;
  input: CreateReviewInput;
}

@Injectable()
export class ReviewsService {
  constructor(private readonly repository: ReviewsRepository) {}

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
