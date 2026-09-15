import { NextResponse } from 'next/server';
import { paginatedSchema, reviewDtoSchema, type ReviewDto } from '@reviews/contracts';
import { apiFetch } from '@/lib/api-client';
import { ApiError } from '@/lib/errors';
import { getServerToken } from '@/lib/session';

const reviewListSchema = paginatedSchema(reviewDtoSchema);

// Bounds how many pages of `GET /me/reviews` (newest first, unfiltered —
// see reviews.controller.ts's `MyReviewsController`) this route walks
// while searching for one product's review. `GET /me/reviews` has no
// `productId` filter of its own — adding one is out of scope for this
// task, which treats the API as frozen — so this is a bounded
// best-effort search, not an exhaustive one: 5 pages of 50 covers 250 of
// a caller's most recent reviews, comfortably more than this seeded
// catalogue's size. A caller who had written more reviews than that for
// *other* products before this one could, in principle, see a false
// "no review yet" here; documented rather than silently accepted.
const MAX_PAGES_SEARCHED = 5;
const PAGE_SIZE = 50;

async function findReviewForProduct(token: string, productId: string): Promise<ReviewDto | null> {
  let cursor: string | undefined;

  for (let page = 0; page < MAX_PAGES_SEARCHED; page += 1) {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (cursor) {
      params.set('cursor', cursor);
    }

    const result = await apiFetch(`/me/reviews?${params.toString()}`, { token, schema: reviewListSchema });
    const match = result.items.find((review) => review.productId === productId);
    if (match) {
      return match;
    }
    if (!result.nextCursor) {
      return null;
    }
    cursor = result.nextCursor;
  }

  return null;
}

/**
 * Proxies `GET /me/reviews` for the browser — the same reason its POST
 * sibling route does: the bearer token lives only in the `httpOnly`
 * `session` cookie, invisible to client JS by design, so this route reads
 * it server-side (see lib/session.ts) and attaches it.
 *
 * `?productId=` narrows the result to one product's review (see
 * `findReviewForProduct` above), which is what `useMyReview` actually
 * asks for — the "have I already reviewed this one?" question behind the
 * "Your review" panel. Without it, this forwards `GET /me/reviews`
 * unchanged: the caller's reviews across every product, cursor-paginated.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const token = await getServerToken();
  if (!token) {
    return NextResponse.json({ message: 'Not signed in.' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const productId = searchParams.get('productId');

  try {
    if (productId) {
      const review = await findReviewForProduct(token, productId);
      return NextResponse.json({ items: review ? [review] : [], nextCursor: null });
    }

    const forwarded = new URLSearchParams(searchParams);
    const query = forwarded.toString();
    const page = await apiFetch(`/me/reviews${query ? `?${query}` : ''}`, { token, schema: reviewListSchema });
    return NextResponse.json(page);
  } catch (error) {
    if (error instanceof ApiError) {
      return NextResponse.json({ message: error.message }, { status: error.status });
    }
    throw error;
  }
}
