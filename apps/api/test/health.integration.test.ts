import { describe, expect, it } from 'vitest';
import { createTestApp, setupTestApp } from './harness.js';

// The worked example every later suite in this plan copies: one
// `setupTestApp()` call at the top of the file wires beforeAll/afterEach/
// afterAll so the app is created once, tables are truncated between tests,
// and the app is closed at the end — no per-file boilerplate.
const ctx = setupTestApp();

describe('GET /api/v1/health', () => {
  it('reports the service as alive', async () => {
    const res = await ctx.request.get('/api/v1/health').expect(200);
    expect(res.body).toMatchObject({ status: 'ok' });
  });
});

describe('GET /api/v1/health/ready', () => {
  it('reports each dependency', async () => {
    const res = await ctx.request.get('/api/v1/health/ready').expect(200);
    // supertest's Response#body is typed `any`; this shape matches the
    // documented readiness response (see HealthController#readiness).
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(res.body.checks).toMatchObject({ database: 'up', cache: 'up' });
  });
});

describe('liveness vs readiness', () => {
  // This is the test that makes the liveness/readiness separation a
  // verified property rather than a claim in a commit message: without it,
  // a handler that just returns a hardcoded { database: 'up', cache: 'up' }
  // would pass every other test in this file. Uses createTestApp directly
  // (not setupTestApp) because only this one test needs a deliberately
  // broken configuration — booting a second, separate app keeps that
  // breakage from touching the shared `ctx` app above.
  it('keeps /health at 200 while /health/ready reports the down dependency and returns 503', async () => {
    // Port 1 is a reserved, near-universally-closed port: connecting to it
    // fails fast with ECONNREFUSED rather than hanging or flaking on
    // whatever happens to be unbound in a given environment.
    const broken = await createTestApp({ REDIS_URL: 'redis://127.0.0.1:1' });
    try {
      const liveness = await broken.request.get('/api/v1/health').expect(200);
      expect(liveness.body).toMatchObject({ status: 'ok' });

      const readiness = await broken.request.get('/api/v1/health/ready').expect(503);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      expect(readiness.body.checks).toMatchObject({ database: 'up', cache: 'down' });
    } finally {
      await broken.close();
    }
  });
});
