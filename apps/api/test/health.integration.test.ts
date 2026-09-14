import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './harness.js';

let ctx: TestApp;
beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(async () => {
  await ctx.close();
});

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
