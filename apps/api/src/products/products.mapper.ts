import type { ProductRatingSummary } from '@reviews/db';
import type { ProductDetailDto, ProductDto, RatingSummaryDto } from '@reviews/contracts';
import type { ProductWithSummary } from './products.repository.js';

const ZERO_DISTRIBUTION: RatingSummaryDto['distribution'] = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };

/**
 * Converts a `product_rating_summary` row into the wire DTO, synthesising
 * an all-zero summary when the row is absent instead of leaving the field
 * missing. Nothing maintains that projection yet for a brand-new product,
 * so "no row" is an expected, not exceptional, case — this is what lets the
 * frontend render a rating widget without a null check on every product.
 *
 * `averageRating` is a Prisma `Decimal`; `.toNumber()` is used rather than
 * `Number(...)` (which would go through the Decimal's string form) so a
 * value like `3.75` crosses the wire as the exact number, not a string or a
 * float that lost precision in transit.
 */
export function toRatingSummaryDto(productId: string, summary: ProductRatingSummary | null): RatingSummaryDto {
  if (!summary) {
    return { productId, reviewCount: 0, averageRating: 0, distribution: ZERO_DISTRIBUTION };
  }

  return {
    productId,
    reviewCount: summary.reviewCount,
    averageRating: summary.averageRating.toNumber(),
    distribution: {
      1: summary.count1,
      2: summary.count2,
      3: summary.count3,
      4: summary.count4,
      5: summary.count5,
    },
  };
}

export function toProductDto(row: ProductWithSummary): ProductDto {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    // The schema allows a null image (Product.imageUrl is optional at the
    // storage layer); the DTO does not. Every fixture and seed row sets one,
    // so this fallback only matters for a row created outside that path.
    imageUrl: row.imageUrl ?? '',
    priceCents: row.priceCents,
    currency: row.currency,
  };
}

/** A list item and a detail payload share the same shape: the product plus its summary. */
export function toProductDetailDto(row: ProductWithSummary): ProductDetailDto {
  return {
    ...toProductDto(row),
    summary: toRatingSummaryDto(row.id, row.ratingSummary),
  };
}
