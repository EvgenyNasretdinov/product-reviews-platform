import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { apiFetch } from './api-client';
import { ApiError } from './errors';

function stubFetch(status: number, body: unknown): ReturnType<typeof vi.fn> {
  // A `Response` body is a single-use stream, so a fresh instance is built
  // on every call rather than resolving to one shared instance — otherwise
  // a test that calls `apiFetch` twice fails on the second call's
  // `response.text()` with "Body has already been read".
  const fetchMock = vi.fn().mockImplementation(
    () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('apiFetch', () => {
  beforeEach(() => {
    vi.stubEnv('API_INTERNAL_URL', 'http://internal.test/api/v1');
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'http://public.test/api/v1');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('parses a successful response with the supplied schema', async () => {
    stubFetch(200, { id: '1', name: 'Lamp' });
    const result = await apiFetch('/products/lamp', { schema: z.object({ id: z.string(), name: z.string() }) });
    expect(result).toEqual({ id: '1', name: 'Lamp' });
  });

  it('throws ApiError carrying the status and the server message', async () => {
    stubFetch(409, { message: 'you have already reviewed this product', reviewId: 'r1' });
    await expect(apiFetch('/products/p/reviews', { method: 'POST' })).rejects.toMatchObject({
      status: 409,
      message: 'you have already reviewed this product',
    });
  });

  it('throws ApiError rather than a ZodError when the body does not match the schema', async () => {
    stubFetch(200, { unexpected: true });
    await expect(apiFetch('/products/lamp', { schema: z.object({ id: z.string() }) })).rejects.toBeInstanceOf(
      ApiError,
    );
  });

  it('attaches a bearer token when one is supplied and omits the header otherwise', async () => {
    const fetchMock = stubFetch(200, { ok: true });

    await apiFetch('/me', { token: 'abc123' });
    const [, initWithToken] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new Headers(initWithToken.headers).get('Authorization')).toBe('Bearer abc123');

    fetchMock.mockClear();

    await apiFetch('/me');
    const [, initWithoutToken] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new Headers(initWithoutToken.headers).has('Authorization')).toBe(false);
  });

  it('uses the internal base URL on the server and the public one in the browser', async () => {
    const fetchMock = stubFetch(200, { ok: true });

    await apiFetch('/health');
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://internal.test/api/v1/health');

    fetchMock.mockClear();
    vi.stubGlobal('window', {});

    await apiFetch('/health');
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://public.test/api/v1/health');
  });
});
