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
 * Proxies `PATCH /reviews/:reviewId` and `DELETE /reviews/:reviewId` for
 * the browser, the same shape and for the same reason as this folder's
 * `vote/route.ts`: editing and deleting happen in response to a click and
 * need to reconcile a client-side cache, so they are not a Server
 * Action's job, but the bearer token lives only in the `session` cookie,
 * which is `httpOnly` and therefore invisible to client code by design.
 *
 * Neither handler re-shapes the upstream response. The API is the sole
 * authority on what an edit or a delete is allowed to do — an edit is the
 * author's alone, while a delete is the author's *or* any moderator's,
 * and that asymmetry is enforced against the row's own `authorId` inside
 * the service, never against anything this route could check. Forwarding
 * the status verbatim is what keeps that the case: a 403 here means the
 * API said 403.
 */
export async function PATCH(request: Request, { params }: RouteContext): Promise<NextResponse> {
  const { reviewId } = await params;

  const token = await getServerToken();
  if (!token) {
    return NextResponse.json({ message: 'Sign in to edit your review.' }, { status: 401 });
  }

  const rawBody = await request.text();

  let upstream: Response;
  try {
    upstream = await fetch(`${requireApiInternalUrl()}/reviews/${reviewId}`, {
      method: 'PATCH',
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
    return NextResponse.json({ message: 'Sign in to delete your review.' }, { status: 401 });
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${requireApiInternalUrl()}/reviews/${reviewId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    return NextResponse.json({ message: 'Failed to reach the review service.' }, { status: 502 });
  }

  // A successful delete is 204 with no body; anything else carries the
  // API's own error JSON, which the caller turns into a message. Passing
  // a body through on 204 would invent one the API never sent.
  if (upstream.status === 204) {
    return new NextResponse(null, { status: 204 });
  }

  const bodyText = await upstream.text();
  return new NextResponse(bodyText, {
    status: upstream.status,
    headers: { 'Content-Type': 'application/json' },
  });
}
