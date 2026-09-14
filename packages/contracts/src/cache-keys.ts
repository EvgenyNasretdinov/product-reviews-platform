import type { ReviewSort } from './review.js';

/**
 * Cache key builders and TTLs shared by every process that reads or
 * invalidates these entries.
 *
 * This module lives in `packages/contracts` rather than in `apps/api`
 * because Plan 2's rating-aggregation worker deletes exactly the keys this
 * package's consumers write, and that worker cannot import from `apps/api`.
 * Keeping the builders in one importable place is what prevents the
 * producer (the API, on a cache-aside read) and the invalidator (the
 * worker, on a published review) from drifting apart — a drifted key would
 * mean the worker deletes nothing, which looks like stale data with no
 * error and no failing test.
 */

/** Seconds a cached product detail payload (product + rating summary) stays fresh. */
export const TTL_PRODUCT_DETAIL = 60;
/** Seconds a cached rating summary stays fresh. */
export const TTL_SUMMARY = 60;
/** Seconds a cached first page of a review list stays fresh. */
export const TTL_REVIEW_LIST = 30;

export const cacheKeys = {
  /** The full `GET /products/:slug` response, keyed by slug (what the route is addressed by). */
  productDetail: (slug: string): string => `product:detail:${slug}`,
  /** A product's rating summary alone, keyed by id (what the aggregation worker has on hand). */
  productSummary: (productId: string): string => `product:summary:${productId}`,
  /**
   * Prefix covering every cached review-list page for a product, across
   * every sort order and rating filter — what the worker deletes by
   * (`delByPrefix`) since a newly published review can shift more than one
   * sort order's first page at once.
   */
  reviewListPrefix: (productId: string): string => `product:${productId}:reviews:`,
  /** The first page of a specific sort/filter combination — the only page cached. */
  reviewListFirstPage: (productId: string, sort: ReviewSort, ratingFilter?: number): string =>
    `${cacheKeys.reviewListPrefix(productId)}${sort}:${ratingFilter ?? 'all'}`,
};
