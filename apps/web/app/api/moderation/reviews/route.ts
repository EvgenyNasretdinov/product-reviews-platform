import { NextResponse } from 'next/server';
import { getServerToken } from '@/lib/session';

function requireApiInternalUrl(): string {
  const apiInternalUrl = process.env.API_INTERNAL_URL;
  if (!apiInternalUrl) {
    throw new Error('API_INTERNAL_URL is not set (required for server-side API calls)');
  }
  return apiInternalUrl;
}

/**
 * Proxies `GET /moderation/reviews` for the browser — the same shape as
 * `app/api/reviews/[reviewId]/vote/route.ts`: `useModerationQueue` runs
 * client-side (the queue pages and reacts to a decision without a full
 * reload), but the bearer token lives only in the `session` cookie, which
 * is `httpOnly` and therefore invisible to that client code by design
 * (see lib/session.ts). This route reads the token server-side and
 * attaches it.
 *
 * Query params (`status`, `cursor`, `limit`) are forwarded verbatim —
 * `ModerationController#listQueue` validates them itself and answers 400
 * for anything malformed, so there is nothing for this proxy to validate
 * twice.
 *
 * Not itself a defence against a non-`MODERATOR` caller: the API's own
 * `RolesGuard` (401 for no token, 403 for an authenticated `CUSTOMER`) is
 * the real control here, same as every other route this app proxies. The
 * page-level redirect in `app/moderation/page.tsx` exists so a `CUSTOMER`
 * who somehow reaches this page doesn't see a queue whose every button
 * then 403s — it is not what makes the queue itself safe.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const token = await getServerToken();
  if (!token) {
    return NextResponse.json({ message: 'Sign in as a moderator to view the queue.' }, { status: 401 });
  }

  const search = new URL(request.url).search;

  let upstream: Response;
  try {
    upstream = await fetch(`${requireApiInternalUrl()}/moderation/reviews${search}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    return NextResponse.json({ message: 'Failed to reach the moderation service.' }, { status: 502 });
  }

  const bodyText = await upstream.text();
  return new NextResponse(bodyText, {
    status: upstream.status,
    headers: { 'Content-Type': 'application/json' },
  });
}
