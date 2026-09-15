import type { ModerationReviewDto, ReviewDto } from '@reviews/contracts';
import type { ReviewWithAuthor, ReviewWithAuthorAndProduct } from './reviews.repository.js';

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

/**
 * Converts a `reviews` row for the *public* listing specifically.
 * `moderationReason` is a moderator's private note about why a review
 * needed attention, not something any visitor browsing a product's reviews
 * should see — and an `APPROVED` review can still carry a leftover value
 * from an earlier moderation pass (flagged, then cleared). Rather than
 * trust `toReviewDto`'s straight column-to-field copy to be the right
 * shape for a public response, this wrapper deliberately overwrites the
 * field with `null` after delegating to it, so the omission is explicit
 * and provable rather than incidental.
 */
export function toPublicReviewDto(row: ReviewWithAuthor): ReviewDto {
  return { ...toReviewDto(row), moderationReason: null };
}

/**
 * `toReviewDto` plus the product's own `name`/`slug` — the moderation
 * queue's own mapper, backing `moderationReviewDtoSchema`
 * (`@reviews/contracts`). Not a variant every review listing gets: see
 * that schema's doc comment for why the product only belongs on the one
 * listing that spans many products at once.
 */
export function toModerationReviewDto(row: ReviewWithAuthorAndProduct): ModerationReviewDto {
  return {
    ...toReviewDto(row),
    product: { name: row.product.name, slug: row.product.slug },
  };
}
