import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, RateLimitedError, ReviewConflictError } from '@/lib/errors';
import { submitReview } from './use-submit-review';

const VALID_INPUT = { rating: 4, title: 'Good lamp', body: 'It has worked well for two months.' };

/**
 * Stubs `global.fetch` for one call. A `Response` body is a single-use
 * stream, so this always builds a fresh `Response` rather than resolving
 * to a shared instance — the same reason lib/api-client.test.ts's
 * `stubFetch` does.
 */
function stubFetch(status: number, body: unknown, headers?: Record<string, string>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json', ...headers },
      }),
    ),
  );
}

describe('submitReview', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('throws ReviewConflictError on a 409, with the server message but no reviewId carried through', async () => {
    stubFetch(409, {
      statusCode: 409,
      message: 'You have already submitted a review for this product',
      reviewId: 'existing-review-id',
    });

    const error = await submitReview('p1', VALID_INPUT).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ReviewConflictError);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(409);
    // ReviewConflictError carries its own fixed copy, not whatever the
    // server happened to send — see its doc comment in lib/errors.ts.
    expect((error as ApiError).message).toBe('You have already reviewed this product.');
    expect(error).not.toHaveProperty('reviewId');
  });

  it('throws RateLimitedError on a 429, reading the seconds from Retry-After', async () => {
    stubFetch(429, { statusCode: 429, message: 'Too many requests' }, { 'Retry-After': '42' });

    const error = await submitReview('p1', VALID_INPUT).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RateLimitedError);
    expect((error as RateLimitedError).status).toBe(429);
    expect((error as RateLimitedError).retryAfterSeconds).toBe(42);
    expect((error as RateLimitedError).message).toBe("You're submitting reviews too quickly. Try again in 42s.");
  });

  it('still throws RateLimitedError on a 429 with no Retry-After header, with a generic message', async () => {
    stubFetch(429, { statusCode: 429, message: 'Too many requests' });

    const error = await submitReview('p1', VALID_INPUT).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RateLimitedError);
    expect((error as RateLimitedError).retryAfterSeconds).toBeUndefined();
    expect((error as RateLimitedError).message).toBe("You're submitting reviews too quickly. Try again shortly.");
  });

  it('throws a plain ApiError for any other failing status, carrying the server message', async () => {
    stubFetch(500, { statusCode: 500, message: 'Something broke upstream' });

    const error = await submitReview('p1', VALID_INPUT).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).not.toBeInstanceOf(ReviewConflictError);
    expect(error).not.toBeInstanceOf(RateLimitedError);
    expect((error as ApiError).status).toBe(500);
    expect((error as ApiError).message).toBe('Something broke upstream');
  });
});
