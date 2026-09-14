import 'reflect-metadata';
import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Role } from '@reviews/db';
import supertest from 'supertest';
import { afterAll, afterEach, beforeAll, inject } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { hashPassword } from '../src/auth/password.js';
import { configureApp } from '../src/bootstrap.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';

export interface TestApp {
  app: INestApplication;
  prisma: PrismaService;
  request: supertest.Agent;
  /**
   * Logs in as `email` through the real `POST /auth/login` route and
   * returns the bearer token, so the token is accepted by the running app
   * exactly as a real client's would be. If `email` doesn't already exist
   * it is created on the fly with a known password — the harness truncates
   * every table between tests (see `truncate`), so no row, seeded or
   * otherwise, is guaranteed to survive into a test body.
   */
  loginAs(email: string): Promise<string>;
  /** Empties every table between tests. Call this from `afterEach`. */
  truncate(): Promise<void>;
  close(): Promise<void>;
}

/** What a suite actually reads once it's set up — see {@link setupTestApp}. */
export interface TestContext {
  readonly app: INestApplication;
  readonly prisma: PrismaService;
  readonly request: supertest.Agent;
  loginAs(email: string): Promise<string>;
}

// The password every loginAs-created account uses. Matches the seeded
// accounts' real password (packages/db/prisma/seed.ts) so a suite that
// happens to also hit the seed script isn't surprised by a mismatch.
const LOGIN_PASSWORD = 'password123';

// Mirrors the three canonical accounts the db package's seed always
// creates (alice/bob/mod — see packages/db/prisma/seed.ts). loginAs
// upserts by email rather than depending on the seed script having run,
// so it works identically against a freshly migrated, unseeded database
// (what every integration test actually runs against) and gives every
// later suite the same three roles to log in as. An email outside this
// map still works — it's created as a plain CUSTOMER — for suites that
// just need *a* distinct authenticated user, not a specific seeded one.
const KNOWN_SEED_ACCOUNTS: Record<string, { displayName: string; role: Role }> = {
  'alice@example.com': { displayName: 'Alice Johnson', role: 'CUSTOMER' },
  'bob@example.com': { displayName: 'Bob Martinez', role: 'CUSTOMER' },
  'mod@example.com': { displayName: 'Morgan Reyes', role: 'MODERATOR' },
};

// argon2id hashing is deliberately slow. loginAs may run once per test
// across many suites, so the fixed login password is hashed once per
// worker process (memoized here) instead of once per call.
let loginPasswordHashPromise: Promise<string> | undefined;
function getLoginPasswordHash(): Promise<string> {
  loginPasswordHashPromise ??= hashPassword(LOGIN_PASSWORD);
  return loginPasswordHashPromise;
}

// The full set of env vars any suite might pass as an override. Every key
// here gets reset to its canonical default on *every* createTestApp call,
// before that call's own overrides are applied. This has to be exhaustive:
// Object.assign only ever adds/overwrites keys, it never removes one, so a
// key missing from this object would leak whatever a *previous* call set on
// process.env into every later call that doesn't explicitly override it —
// this is exactly what test/harness.integration.test.ts guards against.
export const BASE_TEST_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  API_PORT: '3001',
  JWT_SECRET: 'test-secret-that-is-at-least-32-chars',
  JWT_EXPIRES_IN: '12h',
  RABBITMQ_URL: 'amqp://guest:guest@localhost:5672',
  REVIEW_SUBMIT_RATE_LIMIT: '5',
  WEB_ORIGIN: 'http://localhost:3000',
};

/**
 * Boots the real Nest application against this worker's shared Postgres and
 * Redis containers (see global-setup.ts), running it through the exact same
 * `configureApp` bootstrap as `main.ts` — same global prefix, validation
 * pipe, and exception filter the running service uses.
 *
 * `envOverrides` are applied to `process.env` before the Nest module is
 * compiled, so a single suite can run under a different configuration (for
 * example a tighter rate limit, or an unreachable Redis) without changing
 * it for every other suite sharing this worker's containers. Every key in
 * `BASE_TEST_ENV` is reset first, on every call, so an override from one
 * call never leaks into the next call that doesn't repeat it.
 *
 * Most suites want {@link setupTestApp} instead — this function is exported
 * for the cases that genuinely need manual control over the app's
 * lifecycle: booting more than one app in the same test (see
 * test/harness.integration.test.ts), or a deliberately broken configuration
 * that only one test in a file needs (see the liveness/readiness test in
 * test/health.integration.test.ts).
 */
export async function createTestApp(envOverrides: Record<string, string> = {}): Promise<TestApp> {
  Object.assign(
    process.env,
    BASE_TEST_ENV,
    { DATABASE_URL: inject('databaseUrl'), REDIS_URL: inject('redisUrl') },
    envOverrides,
  );

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  configureApp(app); // the same pipes and filters main.ts installs
  await app.init();

  const prisma = app.get(PrismaService);
  // INestApplication#getHttpServer() is typed `any`; narrow it once here so
  // no `any` leaks into the exported TestApp shape.
  const httpServer = app.getHttpServer() as Server;

  const truncate = async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE outbox, review_votes, reviews, product_rating_summary, purchases, products, users RESTART IDENTITY CASCADE',
    );
  };

  const loginAs = async (email: string): Promise<string> => {
    const known = KNOWN_SEED_ACCOUNTS[email];
    const passwordHash = await getLoginPasswordHash();
    const displayName = known?.displayName ?? email.split('@')[0] ?? email;
    const role = known?.role ?? 'CUSTOMER';

    // Upsert rather than create: a suite that calls loginAs(email) more
    // than once (or reuses an email another test in the same file already
    // planted) gets the same known credentials every time instead of a
    // unique-constraint conflict.
    await prisma.user.upsert({
      where: { email },
      create: { email, displayName, passwordHash, role },
      update: { displayName, passwordHash, role },
    });

    const res = await supertest(httpServer).post('/api/v1/auth/login').send({ email, password: LOGIN_PASSWORD });
    if (res.status !== 200) {
      throw new Error(`loginAs(${email}) failed: POST /api/v1/auth/login returned ${res.status}: ${JSON.stringify(res.body)}`);
    }
    // supertest's Response#body is typed `any`; narrow it once here so no
    // `any` leaks into loginAs's Promise<string> return type.
    const body = res.body as { accessToken: string };
    return body.accessToken;
  };

  return {
    app,
    prisma,
    request: supertest(httpServer),
    loginAs,
    truncate,
    close: () => app.close(),
  };
}

/**
 * The documented way for a suite to get a running application — this is
 * what every later integration suite in this plan should call, at the top
 * level of the test file:
 *
 * ```ts
 * const ctx = setupTestApp();
 * it('...', async () => { await ctx.request.get(...); });
 * ```
 *
 * Wires the full lifecycle itself: creates the app once in `beforeAll`,
 * truncates every table in `afterEach` so one test's rows never leak into
 * the next (or into another suite sharing this worker's containers), and
 * closes the app in `afterAll`. `createTestApp` remains available directly
 * for the cases described on its own doc comment.
 */
export function setupTestApp(envOverrides?: Record<string, string>): TestContext {
  let current: TestApp;

  beforeAll(async () => {
    current = await createTestApp(envOverrides);
  });

  afterEach(async () => {
    await current.truncate();
  });

  afterAll(async () => {
    await current.close();
  });

  return {
    get app() {
      return current.app;
    },
    get prisma() {
      return current.prisma;
    },
    get request() {
      return current.request;
    },
    loginAs(email: string) {
      return current.loginAs(email);
    },
  };
}
