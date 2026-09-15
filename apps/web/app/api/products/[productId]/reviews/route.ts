import { NextResponse } from 'next/server';
import { getServerToken } from '@/lib/session';

interface RouteContext {
  params: Promise<{ productId: string }>;
}

/**
 * Proxies `POST /products/:productId/reviews` for the browser.
 * `ReviewForm` runs client-side — a submit button that reacts to typed
 * text and shows inline validation isn't a Server Action's job — but the
 * bearer token lives only in the `session` cookie, which is `httpOnly`
 * and therefore invisible to that client code by design (see
 * lib/session.ts). This route reads the token server-side and attaches
 * it, the same shape `app/api/session/route.ts` already uses for login.
 *
 * Talks to the API with a raw `fetch`, not `apiFetch`: `apiFetch`'s
 * `ApiError` only ever carries `{ message, code }` (see lib/api-client.ts),
 * which would silently drop the 409 response's `reviewId` and the 429
 * response's numeric `Retry-After` header — both load-bearing for how the
 * client explains those two failures in place (see
 * hooks/use-submit-review.ts). Passing the upstream body and that one
 * header through untouched is what keeps them intact.
 */
export async function POST(request: Request, { params }: RouteContext): Promise<NextResponse> {
  const { productId } = await params;

  const token = await getServerToken();
  if (!token) {
    return NextResponse.json({ message: 'Sign in to write a review.' }, { status: 401 });
  }

  const apiInternalUrl = process.env.API_INTERNAL_URL;
  if (!apiInternalUrl) {
    throw new Error('API_INTERNAL_URL is not set (required for server-side API calls)');
  }

  const rawBody = await request.text();

  let upstream: Response;
  try {
    upstream = await fetch(`${apiInternalUrl}/products/${productId}/reviews`, {
      method: 'POST',
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
  const headers = new Headers({ 'Content-Type': 'application/json' });
  // The one header worth forwarding: ReviewSubmitThrottlerGuard's 429
  // carries a numeric Retry-After (see throttle.module.ts), and
  // RateLimitedError (lib/errors.ts) reads it straight off this response.
  const retryAfter = upstream.headers.get('retry-after');
  if (retryAfter) {
    headers.set('Retry-After', retryAfter);
  }

  return new NextResponse(bodyText, { status: upstream.status, headers });
}
