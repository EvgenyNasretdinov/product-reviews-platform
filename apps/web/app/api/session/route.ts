import { loginInputSchema, sessionUserDtoSchema } from '@reviews/contracts';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiFetch } from '@/lib/api-client';
import { ApiError } from '@/lib/errors';
import { SESSION_COOKIE_NAME } from '@/lib/session';

const loginResponseSchema = z.object({ accessToken: z.string(), user: sessionUserDtoSchema });

// Used when the token's own `exp` claim can't be read — matches the API's
// documented JWT_EXPIRES_IN default (see apps/api/.env.example).
const FALLBACK_MAX_AGE_SECONDS = 60 * 60 * 12;

/**
 * Reads the `exp` claim straight off the JWT payload so the cookie expires
 * alongside the token it holds, without re-deriving JWT_EXPIRES_IN as a
 * second source of truth the web app would have to keep in sync with the
 * API's. This only decodes the payload — it never verifies the signature,
 * which is unnecessary here: the token came straight from the API's own
 * login response over a call this route handler just made itself.
 */
function maxAgeFromToken(token: string): number {
  const payloadSegment = token.split('.')[1];
  if (!payloadSegment) {
    return FALLBACK_MAX_AGE_SECONDS;
  }

  try {
    const json = Buffer.from(payloadSegment, 'base64url').toString('utf8');
    const payload = JSON.parse(json) as { exp?: unknown };
    if (typeof payload.exp !== 'number') {
      return FALLBACK_MAX_AGE_SECONDS;
    }
    const secondsRemaining = Math.floor(payload.exp - Date.now() / 1000);
    return secondsRemaining > 0 ? secondsRemaining : FALLBACK_MAX_AGE_SECONDS;
  } catch {
    return FALLBACK_MAX_AGE_SECONDS;
  }
}

/** Proxies login to the API and, on success, sets the httpOnly session cookie. */
export async function POST(request: Request): Promise<NextResponse> {
  const rawBody: unknown = await request.json().catch(() => null);
  const parsedInput = loginInputSchema.safeParse(rawBody);
  if (!parsedInput.success) {
    return NextResponse.json({ message: 'Invalid email or password' }, { status: 400 });
  }

  try {
    const result = await apiFetch('/auth/login', {
      method: 'POST',
      body: JSON.stringify(parsedInput.data),
      schema: loginResponseSchema,
    });

    const response = NextResponse.json({ user: result.user });
    response.cookies.set(SESSION_COOKIE_NAME, JSON.stringify({ token: result.accessToken, user: result.user }), {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: maxAgeFromToken(result.accessToken),
    });
    return response;
  } catch (error) {
    if (error instanceof ApiError) {
      return NextResponse.json({ message: error.message }, { status: error.status });
    }
    throw error;
  }
}

/** Clears the session cookie. */
export function DELETE(): NextResponse {
  const response = NextResponse.json({ ok: true });
  response.cookies.delete(SESSION_COOKIE_NAME);
  return response;
}
