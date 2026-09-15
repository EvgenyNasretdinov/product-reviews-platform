import type { ZodType } from 'zod';
import { ApiError } from './errors';

/**
 * Which base URL to use is decided by *where this code is executing*, not
 * by which Next.js render phase called it. `typeof window === 'undefined'`
 * is true on the server (Route Handlers, Server Components, Server
 * Actions) and false in the browser (Client Components, browser-side
 * effects) — exactly the split that matters, because the two environments
 * cannot reach the API the same way:
 *
 * - The server reaches the API over the Compose network, by service name
 *   (`API_INTERNAL_URL`, e.g. `http://api:3001/api/v1`).
 * - The browser reaches the API over the published host port
 *   (`NEXT_PUBLIC_API_URL`, e.g. `http://localhost:3001/api/v1`) — it has
 *   no DNS entry for the Compose service name `api` at all.
 *
 * Collapsing these into one variable is the classic failure mode here: it
 * produces a site that works perfectly against `next dev` on the host and
 * then breaks the moment the server half runs inside a container, because
 * whichever URL was picked is wrong for one side or the other.
 */
function resolveBaseUrl(): string {
  const isServer = typeof window === 'undefined';
  const url = isServer ? process.env.API_INTERNAL_URL : process.env.NEXT_PUBLIC_API_URL;
  if (!url) {
    throw new Error(
      isServer
        ? 'API_INTERNAL_URL is not set (required for server-side API calls)'
        : 'NEXT_PUBLIC_API_URL is not set (required for browser-side API calls)',
    );
  }
  return url;
}

async function parseJsonBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * The API's error bodies (see apps/api/src/common/openapi/error-response.dto.ts)
 * carry `message` as either a single string or, for aggregated validation
 * failures, an array of strings. This extracts a single display message
 * from whatever shape actually came back, without assuming a schema for
 * the error body itself — error responses are not validated against a
 * Zod schema, only success responses are.
 */
function extractServerMessage(body: unknown, fallback: string): { message: string; code?: string } {
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    const rawMessage = record.message;

    let message: string | undefined;
    if (typeof rawMessage === 'string') {
      message = rawMessage;
    } else if (Array.isArray(rawMessage) && rawMessage.every((entry) => typeof entry === 'string')) {
      message = rawMessage.join('; ');
    }

    const code = typeof record.code === 'string' ? record.code : undefined;
    return { message: message ?? fallback, code };
  }
  return { message: fallback };
}

export interface ApiFetchOptions<T> extends RequestInit {
  /** Parses and validates the response body; the raw JSON is returned unparsed when omitted. */
  schema?: ZodType<T>;
  /** Attached as `Authorization: Bearer <token>` when provided; the header is omitted otherwise. */
  token?: string;
}

/**
 * The one function every call to the API goes through. It resolves the
 * correct base URL for the current execution environment, attaches JSON
 * headers and an optional bearer token, and turns every failure mode —
 * a non-2xx response, a network error, or a response that doesn't match
 * the supplied schema — into the same `ApiError`, so callers never have
 * to distinguish a `ZodError` from an HTTP error from a `TypeError`.
 */
export async function apiFetch<T = unknown>(
  path: string,
  init: ApiFetchOptions<T> = {},
): Promise<T> {
  const { schema, token, headers, ...rest } = init;
  const url = `${resolveBaseUrl()}${path}`;

  const requestHeaders = new Headers(headers);
  requestHeaders.set('Content-Type', 'application/json');
  requestHeaders.set('Accept', 'application/json');
  if (token) {
    requestHeaders.set('Authorization', `Bearer ${token}`);
  }

  let response: Response;
  try {
    response = await fetch(url, { ...rest, headers: requestHeaders });
  } catch (cause) {
    throw new ApiError(502, `Failed to reach ${path}`, undefined, { cause });
  }

  const body = await parseJsonBody(response);

  if (!response.ok) {
    const { message, code } = extractServerMessage(body, `Request to ${path} failed with status ${response.status}`);
    throw new ApiError(response.status, message, code);
  }

  if (!schema) {
    return body as T;
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(502, `Response from ${path} did not match the expected schema`, undefined, {
      cause: parsed.error,
    });
  }
  return parsed.data;
}
