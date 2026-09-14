import 'reflect-metadata';
import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import supertest from 'supertest';
import { inject } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/bootstrap.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';

export interface TestApp {
  app: INestApplication;
  prisma: PrismaService;
  request: supertest.Agent;
  /** Empties every table between tests. Call this from `afterEach`. */
  truncate(): Promise<void>;
  close(): Promise<void>;
}

// Values every suite needs but none of them actually exercises. Kept
// deliberately inert (no queue in this task touches RABBITMQ_URL yet) so
// loadEnv's schema is satisfied without pulling in a fourth container.
const BASE_TEST_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  API_PORT: '3001',
  JWT_SECRET: 'test-secret-that-is-at-least-32-chars',
  JWT_EXPIRES_IN: '12h',
  RABBITMQ_URL: 'amqp://guest:guest@localhost:5672',
};

/**
 * Boots the real Nest application against this worker's shared Postgres and
 * Redis containers (see global-setup.ts), running it through the exact same
 * `configureApp` bootstrap as `main.ts` — same global prefix, validation
 * pipe, and exception filter the running service uses. Every later
 * integration suite in this plan is built on this function.
 *
 * `envOverrides` are applied to `process.env` before the Nest module is
 * compiled, so a single suite can run under a different configuration (for
 * example a tighter rate limit) without changing it for every other suite
 * sharing this worker's containers.
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

  return {
    app,
    prisma,
    request: supertest(httpServer),
    truncate,
    close: () => app.close(),
  };
}
