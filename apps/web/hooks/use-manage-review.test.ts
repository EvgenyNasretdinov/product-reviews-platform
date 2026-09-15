import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/errors';
import { deleteReview, updateReview } from './use-manage-review';

const REVIEW = {
  id: '00000000-0000-4000-8000-000000000001',
  productId: '00000000-0000-4000-8000-0000000000a1',
  author: { id: '00000000-0000-4000-8000-0000000000b1', displayName: 'Alice Johnson' },
  rating: 4,
  title: 'Good lamp',
  body: 'It has worked well for two months.',
  status: 'PENDING',
  verifiedPurchase: false,
  helpfulCount: 0,
  notHelpfulCount: 0,
  moderationReason: null,
  createdAt: '2026-09-01T10:00:00.000Z',
  updatedAt: '2026-09-01T10:00:00.000Z',
  publishedAt: null,
};

/** See use-submit-review.test.ts: a Response body is a single-use stream. */
function stubFetch(status: number, body?: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      body === undefined
        ? new Response(null, { status })
        : new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
    ),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('updateReview', () => {
  it('returns the parsed review on success', async () => {
    stubFetch(200, REVIEW);
    await expect(updateReview(REVIEW.id, { rating: 5 })).resolves.toMatchObject({ id: REVIEW.id, rating: 4 });
  });

  it('sends a PATCH with only the changed fields', async () => {
    stubFetch(200, REVIEW);
    await updateReview(REVIEW.id, { title: 'Still good' });

    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe(`/api/reviews/${REVIEW.id}`);
    expect(init?.method).toBe('PATCH');
    // `updateReview` always sends a JSON string; BodyInit's wider type is
    // what the lint rule is objecting to, not anything this call can produce.
    expect(JSON.parse(init?.body as string)).toEqual({ title: 'Still good' });
  });

  it('explains a 403 as "only the author can edit", not as a generic failure', async () => {
    // A moderator may delete a review but never rewrite one, so this is a
    // reachable state with a button visible — the message has to say why.
    stubFetch(403, { statusCode: 403, message: 'Forbidden resource' });

    const error = await updateReview(REVIEW.id, { rating: 1 }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(403);
    expect((error as ApiError).message).toMatch(/author/i);
  });

  it('joins the array of messages a validation failure returns', async () => {
    stubFetch(400, { statusCode: 400, message: ['title must be longer', 'body must be longer'] });

    const error = await updateReview(REVIEW.id, { title: 'x' }).catch((caught: unknown) => caught);
    expect((error as ApiError).message).toBe('title must be longer; body must be longer');
  });

  it('rejects a success body that is not a review rather than returning it', async () => {
    stubFetch(200, { id: 'not-a-uuid' });

    const error = await updateReview(REVIEW.id, { rating: 3 }).catch((caught: unknown) => caught);
    expect((error as ApiError).status).toBe(502);
  });
});

describe('deleteReview', () => {
  it('resolves on the API\'s 204, which carries no body', async () => {
    stubFetch(204);
    await expect(deleteReview(REVIEW.id)).resolves.toBeUndefined();
  });

  it('treats a 404 as success, since the review is already gone', async () => {
    // A double-click, or a delete racing another tab, must not report a
    // failure for the outcome the caller actually asked for.
    stubFetch(404, { statusCode: 404, message: 'Review not found' });
    await expect(deleteReview(REVIEW.id)).resolves.toBeUndefined();
  });

  it('surfaces a 403 so a failed delete is never mistaken for a completed one', async () => {
    stubFetch(403, { statusCode: 403, message: 'Forbidden resource' });

    const error = await deleteReview(REVIEW.id).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(403);
  });
});
