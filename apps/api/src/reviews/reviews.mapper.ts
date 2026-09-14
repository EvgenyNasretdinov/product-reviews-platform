import type { ReviewDto } from '@reviews/contracts';
import type { ReviewWithAuthor } from './reviews.repository.js';

/** Converts a `reviews` row joined with its author into the wire DTO. */
export function toReviewDto(row: ReviewWithAuthor): ReviewDto {
  return {
    id: row.id,
    productId: row.productId,
    author: {
      id: row.author.id,
      displayName: row.author.displayName,
    },
    rating: row.rating,
    title: row.title,
    body: row.body,
    status: row.status,
    verifiedPurchase: row.verifiedPurchase,
    helpfulCount: row.helpfulCount,
    notHelpfulCount: row.notHelpfulCount,
    createdAt: row.createdAt,
    publishedAt: row.publishedAt,
    moderationReason: row.moderationReason,
  };
}
