/**
 * The one error type every page and route handler in this app should ever
 * see for a failed call through `apiFetch`, whether the failure was the
 * API responding with a non-2xx status, the network call itself failing,
 * or a 2xx body that does not match the schema the caller expected.
 *
 * Collapsing all three into one shape is what lets a page have a single
 * error-handling path instead of three: a `ZodError` (from a schema
 * mismatch) or a raw `TypeError` (from a failed `fetch`) escaping into a
 * React Server Component renders as an opaque framework 500 rather than
 * a handled error state, so neither is allowed to propagate past
 * `apiFetch` — see lib/api-client.ts.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(status: number, message: string, code?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/**
 * A 409 from `POST /products/:productId/reviews` specifically — see
 * reviews.controller.ts's doc comment on `submit`. Its body carries a
 * `reviewId` pointing at the review that already exists, which is what
 * lets a caller navigate the author straight to it rather than just
 * telling them submission failed. That field doesn't belong on plain
 * `ApiError` (every other caller of `apiFetch` would have to know it
 * might be `undefined`); it lives here instead, on a type only review
 * submission ever throws. `error instanceof ApiError` and
 * `error.status === 409` both still work unchanged on this, since it
 * extends `ApiError` rather than replacing it.
 */
export class ReviewConflictError extends ApiError {
  readonly reviewId?: string;

  constructor(message: string, reviewId?: string) {
    super(409, message);
    this.name = 'ReviewConflictError';
    this.reviewId = reviewId;
  }
}

/**
 * A 429 from the same endpoint, when the caller has hit
 * `ReviewSubmitThrottlerGuard`'s per-user limit. `retryAfterSeconds` comes
 * from the response's numeric `Retry-After` header — see
 * throttle.module.ts — which `apiFetch`'s `ApiError` has no way to carry
 * at all (it only ever sees `message`/`code` from the body).
 */
export class RateLimitedError extends ApiError {
  readonly retryAfterSeconds?: number;

  constructor(message: string, retryAfterSeconds?: number) {
    super(429, message);
    this.name = 'RateLimitedError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
