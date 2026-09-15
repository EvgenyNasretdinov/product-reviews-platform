import { NextResponse } from 'next/server';
import { paginatedSchema, reviewDtoSchema } from '@reviews/contracts';
import { apiFetch } from '@/lib/api-client';
import { ApiError } from '@/lib/errors';
import { getServerToken } from '@/lib/session';

const reviewListSchema = paginatedSchema(reviewDtoSchema);

/**
 * Proxies `GET /me/reviews` for the browser — the same reason its POST
 * sibling route does: the bearer token lives only in the `httpOnly`
 * `session` cookie, invisible to client JS by design, so this route reads
 * it server-side (see lib/session.ts) and attaches it.
 *
 * Query params are forwarded straight through, unmodified. In particular
 * `?productId=`, which `useMyReview` sends to ask "have I already
 * reviewed this one?" — the API itself now filters on it (see
 * `MyReviewsController#listMine` and `ReviewsRepository.listByAuthor`),
 * so this route no longer has to page through the caller's whole review
 * history to answer that question; it's just one more query param on one
 * request.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const token = await getServerToken();
  if (!token) {
    return NextResponse.json({ message: 'Not signed in.' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const query = searchParams.toString();

  try {
    const page = await apiFetch(`/me/reviews${query ? `?${query}` : ''}`, { token, schema: reviewListSchema });
    return NextResponse.json(page);
  } catch (error) {
    if (error instanceof ApiError) {
      return NextResponse.json({ message: error.message }, { status: error.status });
    }
    throw error;
  }
}
