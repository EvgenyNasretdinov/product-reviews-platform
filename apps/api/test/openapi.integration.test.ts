import { describe, expect, it } from 'vitest';
import { setupTestApp } from './harness.js';

const ctx = setupTestApp();

// The exact set of paths this API implements as of Task 15 (auth, health,
// products, review listing/submission/management, votes, moderation, and
// the caller's own reviews). Asserted as an explicit sorted array, not
// `toContain` or a length check, on purpose: a controller that ships
// without an `@ApiTags`/route decorator (or one that's accidentally
// excluded from `AppModule`) fails this test immediately instead of going
// unnoticed until someone reads `/docs` by hand.
const EXPECTED_PATHS = [
  '/api/v1/auth/login',
  '/api/v1/auth/me',
  '/api/v1/health',
  '/api/v1/health/ready',
  '/api/v1/me/reviews',
  '/api/v1/moderation/reviews',
  '/api/v1/moderation/reviews/{id}',
  '/api/v1/products',
  '/api/v1/products/{productId}/reviews',
  '/api/v1/products/{slug}',
  '/api/v1/reviews/{id}',
  '/api/v1/reviews/{reviewId}/vote',
];

// A minimal shape for the parts of the OpenAPI document these tests
// inspect — just enough to type `res.body` once per test instead of
// scattering `no-unsafe-member-access` disables (supertest's
// `Response#body` is `any`).
interface MinimalOpenApiDoc {
  paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
  components: { securitySchemes: Record<string, { type: string; scheme: string }> };
}

describe('GET /docs-json', () => {
  it('is served', async () => {
    await ctx.request.get('/docs-json').expect(200);
  });

  it('documents every implemented route', async () => {
    const res = await ctx.request.get('/docs-json').expect(200);
    const body = res.body as MinimalOpenApiDoc;
    const paths = Object.keys(body.paths).sort();
    expect(paths).toEqual(EXPECTED_PATHS);
  });

  it('documents at least one non-200 response for every operation', async () => {
    const res = await ctx.request.get('/docs-json').expect(200);
    const body = res.body as MinimalOpenApiDoc;

    for (const [path, operations] of Object.entries(body.paths)) {
      for (const [method, operation] of Object.entries(operations)) {
        const statuses = Object.keys(operation.responses);
        const nonSuccessStatuses = statuses.filter((status) => !status.startsWith('2'));
        expect(nonSuccessStatuses.length, `${method.toUpperCase()} ${path} documents no non-2xx response`).toBeGreaterThan(0);
      }
    }
  });

  it('documents 202, 400, 401, 404, 409, and 429 for the review-submission operation', async () => {
    const res = await ctx.request.get('/docs-json').expect(200);
    const body = res.body as MinimalOpenApiDoc;
    const submitOperation = body.paths['/api/v1/products/{productId}/reviews']?.post;
    expect(submitOperation && Object.keys(submitOperation.responses).sort()).toEqual(['202', '400', '401', '404', '409', '429']);
  });

  it('declares bearer auth so protected routes can be tried from the UI', async () => {
    const res = await ctx.request.get('/docs-json').expect(200);
    const body = res.body as MinimalOpenApiDoc;
    expect(body.components.securitySchemes).toMatchObject({ bearer: { type: 'http', scheme: 'bearer' } });
  });
});

describe('GET /docs', () => {
  it('serves the Swagger UI', async () => {
    const res = await ctx.request.get('/docs').expect(200);
    expect(res.type).toBe('text/html');
  });
});
