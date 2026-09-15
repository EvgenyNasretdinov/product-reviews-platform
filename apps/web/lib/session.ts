import { cookies } from 'next/headers';
import { sessionUserDtoSchema, type SessionUserDto } from '@reviews/contracts';
import { z } from 'zod';

export const SESSION_COOKIE_NAME = 'session';

export type SessionUser = SessionUserDto;

/**
 * Shape of the `session` cookie's JSON value, as written by
 * `POST /api/session` (app/api/session/route.ts). Validated with the
 * shared `sessionUserDtoSchema` rather than trusted as-is: the cookie is
 * `httpOnly` and set only by our own route handler, but a stale cookie
 * from a previous deploy's slightly different shape, or a value edited
 * out-of-band, should degrade to "signed out" rather than throw inside a
 * Server Component.
 */
const sessionCookieSchema = z.object({
  token: z.string(),
  user: sessionUserDtoSchema,
});

interface Session {
  token: string;
  user: SessionUser;
}

async function readSession(): Promise<Session | null> {
  const store = await cookies();
  const raw = store.get(SESSION_COOKIE_NAME)?.value;
  if (!raw) {
    return null;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return null;
  }

  const result = sessionCookieSchema.safeParse(parsedJson);
  return result.success ? result.data : null;
}

/** The signed-in user for the current request, or `null` when signed out or the cookie is unusable. */
export async function getServerSession(): Promise<SessionUser | null> {
  const session = await readSession();
  return session ? session.user : null;
}

/** The bearer token for the current request, or `null` when signed out or the cookie is unusable. */
export async function getServerToken(): Promise<string | null> {
  const session = await readSession();
  return session ? session.token : null;
}
