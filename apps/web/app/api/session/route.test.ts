import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { apiFetchMock } = vi.hoisted(() => ({ apiFetchMock: vi.fn() }));

vi.mock('@/lib/api-client', () => ({
  apiFetch: apiFetchMock,
}));

const { POST, DELETE } = await import('./route');

/** A syntactically valid (unsigned) JWT so maxAgeFromToken can decode its payload. */
function fakeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.signature`;
}

const ACCESS_TOKEN = fakeJwt({ sub: 'user-1', exp: Math.floor(Date.now() / 1000) + 3600 });

const LOGIN_RESULT = {
  accessToken: ACCESS_TOKEN,
  user: {
    id: '11111111-1111-1111-1111-111111111111',
    email: 'alice@example.com',
    displayName: 'Alice Anderson',
    role: 'CUSTOMER',
  },
};

function loginRequest(): Request {
  return new Request('http://localhost/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'alice@example.com', password: 'password123' }),
  });
}

describe('POST /api/session', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    apiFetchMock.mockResolvedValue(LOGIN_RESULT);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('sets the session cookie httpOnly, SameSite=lax, and scoped to the whole app', async () => {
    const response = await POST(loginRequest());
    const setCookie = response.headers.get('set-cookie') ?? '';

    expect(setCookie).toContain('session=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=lax');
    expect(setCookie).toContain('Path=/');
  });

  it('omits Secure outside production', async () => {
    vi.stubEnv('NODE_ENV', 'development');

    const response = await POST(loginRequest());
    const setCookie = response.headers.get('set-cookie') ?? '';

    expect(setCookie).not.toContain('Secure');
  });

  it('includes Secure when NODE_ENV is production', async () => {
    vi.stubEnv('NODE_ENV', 'production');

    const response = await POST(loginRequest());
    const setCookie = response.headers.get('set-cookie') ?? '';

    expect(setCookie).toContain('Secure');
  });

  it('never puts the access token in the response body', async () => {
    const response = await POST(loginRequest());
    const bodyText = await response.text();

    expect(bodyText).not.toContain(ACCESS_TOKEN);
  });
});

describe('DELETE /api/session', () => {
  it('clears the session cookie', () => {
    const response = DELETE();
    const setCookie = response.headers.get('set-cookie') ?? '';

    expect(setCookie).toMatch(/session=;/);
  });
});
