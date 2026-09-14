import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
    redisUrl: string;
  }
}

// apps/api/test/global-setup.ts -> repo root.
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/**
 * Runs once per Vitest worker, before any integration test file in that
 * worker executes. Starts one Postgres and one Redis container, migrates
 * the database, and publishes both connection URLs via `provide()` so test
 * files read them with `inject()` (see test/harness.ts). Both containers
 * are torn down in the returned teardown function.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const [postgres, redis]: [StartedPostgreSqlContainer, StartedRedisContainer] = await Promise.all([
    new PostgreSqlContainer('postgres:17-alpine').start(),
    new RedisContainer('redis:7-alpine').start(),
  ]);

  const databaseUrl = postgres.getConnectionUri();
  const redisUrl = redis.getConnectionUrl();

  execFileSync('pnpm', ['--filter', '@reviews/db', 'run', 'db:migrate'], {
    cwd: REPO_ROOT,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'inherit',
  });

  project.provide('databaseUrl', databaseUrl);
  project.provide('redisUrl', redisUrl);

  return async () => {
    await Promise.all([postgres.stop(), redis.stop()]);
  };
}
