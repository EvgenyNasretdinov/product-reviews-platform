import { randomUUID } from 'node:crypto';
import { JwtService } from '@nestjs/jwt';
import type { SessionUserDto } from '@reviews/contracts';
import type { Role } from '@reviews/db';
import { describe, expect, it } from 'vitest';
import { hashPassword } from '../src/auth/password.js';
import { BASE_TEST_ENV, setupTestApp } from './harness.js';

// supertest's Response#body is typed `any`; every test below narrows it
// through this shape once instead of sprinkling eslint-disable comments
// at each access.
interface LoginResponseBody {
  accessToken: string;
  user: SessionUserDto;
}

// The worked example every later suite in this plan copies for auth:
// one setupTestApp() call, and a local helper that plants a user directly
// via Prisma (the harness truncates every table between tests, so no seed
// row survives from one test to the next).
const ctx = setupTestApp();

const PASSWORD = 'password123';

interface SeedUserOverrides {
  email?: string;
  displayName?: string;
  role?: Role;
}

async function seedUser(overrides: SeedUserOverrides = {}) {
  const passwordHash = await hashPassword(PASSWORD);
  return ctx.prisma.user.create({
    data: {
      email: overrides.email ?? `user-${randomUUID()}@example.com`,
      displayName: overrides.displayName ?? 'Test User',
      passwordHash,
      role: overrides.role ?? 'CUSTOMER',
    },
  });
}

describe('POST /api/v1/auth/login', () => {
  // Case 1.
  it('returns a token and the session user for valid credentials, with no passwordHash anywhere in the body', async () => {
    const user = await seedUser({ email: 'alice@example.com', displayName: 'Alice Johnson', role: 'CUSTOMER' });

    const res = await ctx.request
      .post('/api/v1/auth/login')
      .send({ email: 'alice@example.com', password: PASSWORD })
      .expect(200);

    const body = res.body as LoginResponseBody;
    expect(typeof body.accessToken).toBe('string');
    expect(body.accessToken.length).toBeGreaterThan(0);
    expect(body.user).toEqual({
      id: user.id,
      email: 'alice@example.com',
      displayName: 'Alice Johnson',
      role: 'CUSTOMER',
    });
    expect(body.user).not.toHaveProperty('passwordHash');
    expect(JSON.stringify(body)).not.toContain('passwordHash');
    expect(JSON.stringify(body)).not.toContain(user.passwordHash);
  });

  // Case 2.
  it('returns an identical 401 body for a wrong password and for an unknown email', async () => {
    await seedUser({ email: 'bob@example.com' });

    const wrongPassword = await ctx.request
      .post('/api/v1/auth/login')
      .send({ email: 'bob@example.com', password: 'not-the-password' })
      .expect(401);

    const unknownEmail = await ctx.request
      .post('/api/v1/auth/login')
      .send({ email: 'nobody-registered@example.com', password: PASSWORD })
      .expect(401);

    expect(wrongPassword.body).toEqual(unknownEmail.body);
  });

  // Case 3.
  it('returns 401 for an unknown email', async () => {
    const res = await ctx.request
      .post('/api/v1/auth/login')
      .send({ email: 'ghost@example.com', password: PASSWORD })
      .expect(401);

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(res.body.message).toBeDefined();
  });
});

describe('GET /api/v1/auth/me', () => {
  // Case 4.
  it('returns 401 without a token', async () => {
    await ctx.request.get('/api/v1/auth/me').expect(401);
  });

  // Case 5.
  it('returns the same user as the login response for a valid token', async () => {
    const user = await seedUser({ email: 'alice@example.com', displayName: 'Alice Johnson', role: 'CUSTOMER' });

    const loginRes = await ctx.request
      .post('/api/v1/auth/login')
      .send({ email: 'alice@example.com', password: PASSWORD })
      .expect(200);

    const accessToken = (loginRes.body as LoginResponseBody).accessToken;

    const res = await ctx.request.get('/api/v1/auth/me').auth(accessToken, { type: 'bearer' }).expect(200);

    expect(res.body).toEqual({
      id: user.id,
      email: 'alice@example.com',
      displayName: 'Alice Johnson',
      role: 'CUSTOMER',
    });
  });

  // Case 6.
  it('returns 401 for a token signed with a different secret', async () => {
    const forgedToken = new JwtService({ secret: 'a-completely-different-secret-of-32-chars' }).sign({
      sub: randomUUID(),
      email: 'forger@example.com',
      role: 'CUSTOMER',
    });

    await ctx.request.get('/api/v1/auth/me').auth(forgedToken, { type: 'bearer' }).expect(401);
  });

  // Extra hardening case, beyond the brief's six: proves the `algorithms:
  // ['HS256']` allow-list in JwtStrategy actually rejects something, not
  // just that it exists. Signs with the *correct* secret, for a *real*
  // user, but a different HMAC algorithm (HS384). The real user matters:
  // without it, a rejected-for-any-reason token (including "no such user")
  // would pass this assertion whether or not the allow-list did anything,
  // which is exactly the kind of test that cannot fail for the reason it
  // names. Without an explicit allow-list, jsonwebtoken accepts any
  // HS-family algorithm for a string secret by default, so this token
  // would have been accepted and returned that real user's data (200)
  // before the allow-list was added — this is a different failure mode
  // from case 6 (wrong secret), which an allow-list has no bearing on.
  it('returns 401 for a real user token signed with the correct secret but an algorithm outside the allow-list', async () => {
    const user = await seedUser({ email: 'alice@example.com', displayName: 'Alice Johnson', role: 'CUSTOMER' });

    const forgedToken = new JwtService({ secret: BASE_TEST_ENV.JWT_SECRET }).sign(
      { sub: user.id, email: user.email, role: user.role },
      { algorithm: 'HS384' },
    );

    await ctx.request.get('/api/v1/auth/me').auth(forgedToken, { type: 'bearer' }).expect(401);
  });
});

