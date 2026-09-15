import { NextResponse } from 'next/server';
import { getServerToken } from '@/lib/session';

interface RouteContext {
  params: Promise<{ reviewId: string }>;
}

function requireApiInternalUrl(): string {
  const apiInternalUrl = process.env.API_INTERNAL_URL;
  if (!apiInternalUrl) {
    throw new Error('API_INTERNAL_URL is not set (required for server-side API calls)');
  }
  return apiInternalUrl;
}

/**
 * Proxies `PUT /reviews/:reviewId/vote` and `DELETE /reviews/:reviewId/vote`
 * for the browser — the same shape as `app/api/products/[productId]/reviews/route.ts`'s
 * `POST`, and for the same reason: `useVote` runs client-side (voting has
 * to react to a click and roll back in place; it isn't a Server Action's
 * job), but the bearer token lives only in the `session` cookie, which is
 * `httpOnly` and therefore invisible to that client code by design (see
 * lib/session.ts). This route reads the token server-side and attaches it.
 *
 * Both handlers forward the upstream body and status verbatim rather than
 * re-shaping them: `PUT`'s 200 body is the review's updated counts,
 * `DELETE`'s 204 has none, and neither this route nor `useVote` needs to
 * parse either — `useVote` reconciles its own optimistic cache patch by
 * invalidating and refetching on settle instead of trusting this
 * response's body.
 */
export async function PUT(request: Request, { params }: RouteContext): Promise<NextResponse> {
  const { reviewId } = await params;

  const token = await getServerToken();
  if (!token) {
    return NextResponse.json({ message: 'Sign in to vote on a review.' }, { status: 401 });
  }

  const rawBody = await request.text();

  let upstream: Response;
  try {
    upstream = await fetch(`${requireApiInternalUrl()}/reviews/${reviewId}/vote`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: rawBody,
    });
  } catch {
    return NextResponse.json({ message: 'Failed to reach the review service.' }, { status: 502 });
  }

  const bodyText = await upstream.text();
  return new NextResponse(bodyText, {
    status: upstream.status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function DELETE(_request: Request, { params }: RouteContext): Promise<NextResponse> {
  const { reviewId } = await params;

  const token = await getServerToken();
  if (!token) {
    return NextResponse.json({ message: 'Sign in to vote on a review.' }, { status: 401 });
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${requireApiInternalUrl()}/reviews/${reviewId}/vote`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    return NextResponse.json({ message: 'Failed to reach the review service.' }, { status: 502 });
  }

  // 204 has no body — constructing a NextResponse with an empty string and
  // upstream's own status (204) matches it without inventing a JSON body
  // the API itself never sent.
  return new NextResponse(null, { status: upstream.status });
}
