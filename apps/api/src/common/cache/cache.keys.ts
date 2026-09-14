// Re-exported from @reviews/contracts rather than defined here: Plan 2's
// rating-aggregation worker deletes exactly these keys and cannot import
// from apps/api, so the builders and TTLs live in the shared contracts
// package and this module just hands them to the rest of the API. Do not
// redefine any of these — a hand-restated copy is exactly the drift this
// arrangement exists to prevent.
export { cacheKeys, TTL_PRODUCT_DETAIL, TTL_SUMMARY, TTL_REVIEW_LIST } from '@reviews/contracts';
