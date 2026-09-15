import { NextResponse } from 'next/server';
import { getServerToken } from '@/lib/session';

interface RouteContext {
  params: Promise<{ id: string }>;
}

function requireApiInternalUrl(): string {
  const apiInternalUrl = process.env.API_INTERNAL_URL;
  if (!apiInternalUrl) {
    throw new Error('API_INTERNAL_URL is not set (required for server-side API calls)');
  }
  return apiInternalUrl;
}

/**
 * Proxies `POST /moderation/reviews/:id` for the browser, attaching the
 * bearer token server-side — see `app/api/moderation/reviews/route.ts`'s
 * doc comment for why this needs a route handler at all rather than
 * `useModerationDecision` calling the API directly.
 *
 * The upstream body and status are forwarded verbatim: a 400 (rejecting
 * with no reason), 404 (no such review), or 409 (already decided) all
 * need to reach `useModerationDecision`'s `ApiError` unchanged for
 * `ModerationQueue`/`ModerationDecisionDialog` to explain the failure in
 * place rather than as a generic message.
 */
export async function POST(request: Request, { params }: RouteContext): Promise<NextResponse> {
  const { id } = await params;

  const token = await getServerToken();
  if (!token) {
    return NextResponse.json({ message: 'Sign in as a moderator to record a decision.' }, { status: 401 });
  }

  const rawBody = await request.text();

  let upstream: Response;
  try {
    upstream = await fetch(`${requireApiInternalUrl()}/moderation/reviews/${id}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: rawBody,
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
