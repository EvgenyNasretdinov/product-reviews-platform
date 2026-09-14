import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import * as argon2 from 'argon2';
import { Test, type TestingModule } from '@nestjs/testing';
import { createPrismaClient, type PrismaClient, type Role } from '@reviews/db';
import { EVENT_TYPES, type EventEnvelope } from '@reviews/contracts';
import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { EventPublisher } from '../src/messaging/event.publisher.js';
import { parseEnvelope } from '../src/relay/outbox.repository.js';
import { SummaryRepository } from '../src/aggregation/summary.repository.js';

/**
 * The end-to-end test the whole architecture exists to pass: it boots the
 * real API (as a real HTTP server, out of process — see `createApiHarness`
 * for why) and the real worker (in process, via `AppModule`, since that is
 * exactly what Task 6 wires together) against the same shared Postgres,
 * RabbitMQ, and Redis containers this file's own `global-setup.ts` starts,
 * then only ever talks to the API over HTTP.
 *
 * Nothing here reaches into the outbox table, the broker, or a consumer
 * directly to observe a state change — every assertion is something a
 * real client of the API could also see. The one narrow exception is the
 * "duplicated outbox delivery" case, which necessarily has no observable
 * HTTP effect of its own (a correctly-handled duplicate changes nothing);
 * it confirms the duplicate was actually processed by reading
 * `product_rating_summary.updated_at` directly, which is the only way to
 * tell "the duplicate was silently ignored" apart from "the duplicate was
 * never delivered at all".
 */

const API_MAIN = fileURLToPath(new URL('../../api/dist/src/main.js', import.meta.url));
const LOGIN_PASSWORD = 'pipeline-test-password';
const JWT_SECRET = 'pipeline-test-secret-that-is-at-least-32-characters-long';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls `check` until it resolves without throwing, or rethrows its last failure once `timeout` elapses. Never sleeps a fixed duration on the happy path. */
async function waitFor(check: () => Promise<void>, opts: { timeout: number; interval: number }): Promise<void> {
  const deadline = Date.now() + opts.timeout;
  for (;;) {
    try {
      await check();
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await sleep(opts.interval);
    }
  }
}

/** An OS-assigned free TCP port, so the spawned API process and this test never collide with each other or anything else on the host. */
async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, () => {
      const address = server.address();
      server.close(() => {
        if (address === null || typeof address === 'string') {
          reject(new Error('could not determine a free port'));
          return;
        }
        resolve(address.port);
      });
    });
  });
}

interface ApiHarness {
  request: ReturnType<typeof supertest>;
  loginAs(email: string, role?: Role): Promise<string>;
  close(): Promise<void>;
}

/**
 * Spawns the real, built API (`apps/api/dist/src/main.js` — built once by
 * this package's `pretest:integration` script, the same "build once,
 * reuse across runs" pattern already used for `@reviews/db` and
 * `@reviews/contracts`) as its own process, and waits for it to answer
 * its own liveness probe.
 *
 * Out of process, not `Test.createTestingModule` in process, deliberately:
 * `apps/api` and `apps/worker` are separate packages with no dependency
 * between them (each has its own `tsconfig.json` `rootDir`, its own
 * `node_modules`), so importing `apps/api`'s Nest module graph directly
 * from a worker test file doesn't type-check — see this task's own report
 * for the `TS6059` error that rules it out. A real, separately-running API
 * process is also a closer match to what "no reaching into internals"
 * means for the headline test: the only thing this harness exposes is an
 * HTTP client.
 */
async function createApiHarness(prisma: PrismaClient): Promise<ApiHarness> {
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  const child: ChildProcess = spawn(process.execPath, [API_MAIN], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      API_PORT: String(port),
      DATABASE_URL: inject('databaseUrl'),
      REDIS_URL: inject('redisUrl'),
      RABBITMQ_URL: inject('rabbitmqUrl'),
      JWT_SECRET,
      JWT_EXPIRES_IN: '12h',
      REVIEW_SUBMIT_RATE_LIMIT: '100',
      WEB_ORIGIN: 'http://localhost:3000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  let exitInfo = '';
  child.once('exit', (code, signal) => {
    exitInfo = `exited with code ${String(code)} signal ${String(signal)}`;
  });

  await waitForHealthy(baseUrl, child, () => `${exitInfo}\n${stderr}`);

  const request = supertest(baseUrl);

  let passwordHashPromise: Promise<string> | undefined;
  const getPasswordHash = (): Promise<string> => {
    passwordHashPromise ??= argon2.hash(LOGIN_PASSWORD, { type: argon2.argon2id });
    return passwordHashPromise;
  };

  const loginAs = async (email: string, role: Role = 'CUSTOMER'): Promise<string> => {
    const passwordHash = await getPasswordHash();
    const displayName = email.split('@')[0] ?? email;
    await prisma.user.upsert({
      where: { email },
      create: { email, displayName, passwordHash, role },
      update: { displayName, passwordHash, role },
    });

    const res = await request.post('/api/v1/auth/login').send({ email, password: LOGIN_PASSWORD });
    if (res.status !== 200) {
      throw new Error(`loginAs(${email}) failed: POST /auth/login returned ${res.status}: ${JSON.stringify(res.body)}`);
    }
    return (res.body as { accessToken: string }).accessToken;
  };

  return {
    request,
    loginAs,
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
      });
    },
  };
}

async function waitForHealthy(baseUrl: string, child: ChildProcess, describeFailure: () => string): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`api process exited before becoming healthy: ${describeFailure()}`);
    }
    try {
      const res = await fetch(`${baseUrl}/api/v1/health`);
      if (res.ok) return;
    } catch (error) {
      lastError = error;
    }
    await sleep(200);
  }
  throw new Error(`api process never became healthy: ${String(lastError)}\n${describeFailure()}`);
}

interface WorkerHarness {
  /**
   * Recomputes `product_rating_summary` for `productId` directly through
   * the same `SummaryRepository` the aggregation consumer itself uses —
   * not hand-computed in the fixture — without booting the rest of the
   * worker. Lets a test establish a realistic "before" projection for
   * reviews it seeded straight into the database (bypassing submission
   * and moderation, since those aren't what's under test in the seed
   * step) without waiting on a queue that isn't running yet.
   */
  recomputeNow(productId: string): Promise<void>;
  /** Boots the real `AppModule` — the relay and both consumers, wired exactly as `main.ts` wires them. */
  start(): Promise<void>;
  /** Publishes `envelope` again through the worker's own `EventPublisher`, simulating a duplicate broker delivery. Requires `start()` to have already run. */
  republish(envelope: EventEnvelope): Promise<void>;
  stop(): Promise<void>;
}

function createWorkerHarness(prisma: PrismaClient): WorkerHarness {
  let moduleRef: TestingModule | undefined;

  return {
    async recomputeNow(productId) {
      const repository = new SummaryRepository();
      await prisma.$transaction((tx) => repository.recompute(tx, productId));
    },
    async start() {
      moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      await moduleRef.init();
    },
    async republish(envelope) {
      if (!moduleRef) {
        throw new Error('worker.republish() called before worker.start()');
      }
      await moduleRef.get(EventPublisher).publish(envelope);
    },
    async stop() {
      await moduleRef?.close();
      moduleRef = undefined;
    },
  };
}

async function createProduct(prisma: PrismaClient): Promise<{ id: string; slug: string }> {
  const slug = `pipeline-${randomUUID()}`;
  return prisma.product.create({
    data: {
      slug,
      name: 'Pipeline test product',
      description: 'A product used by the end-to-end pipeline test.',
      priceCents: 4999,
      currency: 'USD',
    },
    select: { id: true, slug: true },
  });
}

/** Seeds one already-published, already-approved review per rating in `ratings`, each by its own fresh author. Does not touch `product_rating_summary` — see `WorkerHarness.recomputeNow`. */
async function seedApprovedReviews(prisma: PrismaClient, productId: string, ratings: number[]): Promise<void> {
  for (const rating of ratings) {
    const author = await prisma.user.create({
      data: {
        email: `seed-${randomUUID()}@example.com`,
        displayName: 'Seed Author',
        passwordHash: 'not-a-real-hash',
        role: 'CUSTOMER',
      },
    });
    await prisma.review.create({
      data: {
        productId,
        authorId: author.id,
        rating,
        title: 'A previously approved review',
        body: 'Seeded directly so the pipeline test has a known starting average.',
        status: 'APPROVED',
        verifiedPurchase: false,
        publishedAt: new Date(),
      },
    });
  }
}

interface ProductSummaryBody {
  summary: { reviewCount: number; averageRating: number; distribution: Record<string, number> };
}
interface ReviewListBody {
  items: { id: string; title: string; status: string }[];
}
interface SubmitReviewBody {
  id: string;
}

describe('event pipeline', () => {
  let prisma: PrismaClient;
  let api: ApiHarness;
  let worker: WorkerHarness;

  beforeAll(async () => {
    prisma = createPrismaClient(inject('databaseUrl'));
    api = await createApiHarness(prisma);

    // The worker's own AppModule reads its configuration from
    // process.env at compile time (see ConfigModule) — mirrors
    // boot.integration.test.ts, which sets up this same worker process's
    // env the same way.
    process.env.DATABASE_URL = inject('databaseUrl');
    process.env.RABBITMQ_URL = inject('rabbitmqUrl');
    process.env.REDIS_URL = inject('redisUrl');

    worker = createWorkerHarness(prisma);
    // Started here, not inside the first test: tests 2-4 submit a review
    // and wait for the moderation/aggregation queues to process it without
    // ever calling worker.start() themselves, so they only ever passed
    // because vitest runs this file's tests in declaration order and test
    // 1 happened to start the worker as a side effect — a suite that
    // passes only because an earlier test in the same file ran first.
    await worker.start();
  }, 60_000);

  afterAll(async () => {
    await worker.stop();
    await api.close();
    await prisma.$disconnect();
  }, 30_000);

  it(
    'publishes a clean review and updates the rating through the whole pipeline',
    async () => {
      const token = await api.loginAs('alice@example.com');
      const product = await createProduct(prisma);
      await seedApprovedReviews(prisma, product.id, [5, 3]); // existing average 4.00
      await worker.recomputeNow(product.id);

      const before = await api.request.get(`/api/v1/products/${product.slug}`).expect(200);
      expect((before.body as ProductSummaryBody).summary).toMatchObject({ reviewCount: 2, averageRating: 4 });

      await api.request
        .post(`/api/v1/products/${product.id}/reviews`)
        .auth(token, { type: 'bearer' })
        .send({ rating: 1, title: 'Broke in a week', body: 'The switch failed after six days of light use.' })
        .expect(202);

      await waitFor(
        async () => {
          const res = await api.request.get(`/api/v1/products/${product.slug}`);
          expect((res.body as ProductSummaryBody).summary.reviewCount).toBe(3);
        },
        { timeout: 15_000, interval: 250 },
      );

      const after = await api.request.get(`/api/v1/products/${product.slug}`).expect(200);
      expect((after.body as ProductSummaryBody).summary).toMatchObject({
        reviewCount: 3,
        averageRating: 3,
        distribution: { '1': 1, '2': 0, '3': 1, '4': 0, '5': 1 },
      });

      const list = await api.request.get(`/api/v1/products/${product.id}/reviews?sort=newest`).expect(200);
      expect((list.body as ReviewListBody).items[0]).toMatchObject({ title: 'Broke in a week', status: 'APPROVED' });
    },
    45_000,
  );

  it(
    'keeps a rejected review out of the rating and out of the public list',
    async () => {
      const token = await api.loginAs('bob@example.com');
      const product = await createProduct(prisma);
      await seedApprovedReviews(prisma, product.id, [4]);
      await worker.recomputeNow(product.id);

      await api.request
        .post(`/api/v1/products/${product.id}/reviews`)
        .auth(token, { type: 'bearer' })
        .send({ rating: 2, title: 'Not happy', body: 'This product is complete crap, would not buy again.' })
        .expect(202);

      await waitFor(
        async () => {
          const mine = await api.request.get('/api/v1/me/reviews').auth(token, { type: 'bearer' });
          const found = (mine.body as ReviewListBody).items.find((r) => r.title === 'Not happy');
          expect(found?.status).toBe('REJECTED');
        },
        { timeout: 15_000, interval: 250 },
      );

      const summary = await api.request.get(`/api/v1/products/${product.slug}`).expect(200);
      expect((summary.body as ProductSummaryBody).summary).toMatchObject({ reviewCount: 1, averageRating: 4 });

      const list = await api.request.get(`/api/v1/products/${product.id}/reviews?sort=newest`).expect(200);
      expect((list.body as ReviewListBody).items.some((r) => r.title === 'Not happy')).toBe(false);
    },
    45_000,
  );

  it(
    'routes a flagged review to the moderation queue and publishes it on approval',
    async () => {
      const token = await api.loginAs('carol@example.com');
      const modToken = await api.loginAs('pipeline-mod@example.com', 'MODERATOR');
      const product = await createProduct(prisma);
      await seedApprovedReviews(prisma, product.id, [3]);
      await worker.recomputeNow(product.id);

      const shoutingBody = 'THIS THING IS ABSOLUTELY AMAZING AND WORKS GREAT EVERY SINGLE DAY OF THE WEEK';
      const submitRes = await api.request
        .post(`/api/v1/products/${product.id}/reviews`)
        .auth(token, { type: 'bearer' })
        .send({ rating: 5, title: 'SO GOOD', body: shoutingBody })
        .expect(202);
      const reviewId = (submitRes.body as SubmitReviewBody).id;

      await waitFor(
        async () => {
          const mine = await api.request.get('/api/v1/me/reviews').auth(token, { type: 'bearer' });
          const found = (mine.body as ReviewListBody).items.find((r) => r.id === reviewId);
          expect(found?.status).toBe('FLAGGED');
        },
        { timeout: 15_000, interval: 250 },
      );

      const queue = await api.request
        .get('/api/v1/moderation/reviews?status=FLAGGED')
        .auth(modToken, { type: 'bearer' })
        .expect(200);
      expect((queue.body as ReviewListBody).items.some((r) => r.id === reviewId)).toBe(true);

      const publicListBefore = await api.request.get(`/api/v1/products/${product.id}/reviews?sort=newest`).expect(200);
      expect((publicListBefore.body as ReviewListBody).items.some((r) => r.id === reviewId)).toBe(false);

      await api.request
        .post(`/api/v1/moderation/reviews/${reviewId}`)
        .auth(modToken, { type: 'bearer' })
        .send({ decision: 'APPROVED', reason: null })
        .expect(200);

      await waitFor(
        async () => {
          const res = await api.request.get(`/api/v1/products/${product.slug}`);
          expect((res.body as ProductSummaryBody).summary.reviewCount).toBe(2);
        },
        { timeout: 15_000, interval: 250 },
      );

      const publicListAfter = await api.request.get(`/api/v1/products/${product.id}/reviews?sort=newest`).expect(200);
      expect((publicListAfter.body as ReviewListBody).items.some((r) => r.id === reviewId)).toBe(true);
    },
    45_000,
  );

  it(
    'survives a duplicated outbox delivery without double-counting',
    async () => {
      const token = await api.loginAs('dave@example.com');
      const product = await createProduct(prisma);
      await seedApprovedReviews(prisma, product.id, [5]);
      await worker.recomputeNow(product.id);

      const submitRes = await api.request
        .post(`/api/v1/products/${product.id}/reviews`)
        .auth(token, { type: 'bearer' })
        .send({ rating: 4, title: 'Solid pick', body: 'Works exactly as described, happy with the purchase.' })
        .expect(202);
      const reviewId = (submitRes.body as SubmitReviewBody).id;

      await waitFor(
        async () => {
          const res = await api.request.get(`/api/v1/products/${product.slug}`);
          expect((res.body as ProductSummaryBody).summary.reviewCount).toBe(2);
        },
        { timeout: 15_000, interval: 250 },
      );

      const summaryBefore = await prisma.productRatingSummary.findUniqueOrThrow({ where: { productId: product.id } });
      expect(summaryBefore.reviewCount).toBe(2);

      const outboxRow = await prisma.outboxEvent.findFirstOrThrow({
        where: { aggregateId: reviewId, eventType: EVENT_TYPES.REVIEW_APPROVED, publishedAt: { not: null } },
      });
      const envelope = parseEnvelope(outboxRow.payload);

      await worker.republish(envelope);

      // A correctly-handled duplicate has no observable HTTP effect of its
      // own — reviewCount doesn't change — so the only way to tell "the
      // duplicate was silently absorbed" apart from "the duplicate was
      // never actually delivered" is to watch the projection actually
      // recompute (its updated_at moving) before asserting the count it
      // recomputed to is unchanged.
      await waitFor(
        async () => {
          const summaryAfter = await prisma.productRatingSummary.findUniqueOrThrow({ where: { productId: product.id } });
          expect(summaryAfter.updatedAt.getTime()).toBeGreaterThan(summaryBefore.updatedAt.getTime());
        },
        { timeout: 15_000, interval: 250 },
      );

      const summaryFinal = await prisma.productRatingSummary.findUniqueOrThrow({ where: { productId: product.id } });
      expect(summaryFinal.reviewCount).toBe(2);

      const res = await api.request.get(`/api/v1/products/${product.slug}`).expect(200);
      expect((res.body as ProductSummaryBody).summary.reviewCount).toBe(2);
    },
    45_000,
  );
});
