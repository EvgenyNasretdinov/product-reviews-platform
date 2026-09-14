import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RabbitMQContainer, type StartedRabbitMQContainer } from '@testcontainers/rabbitmq';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
    rabbitmqUrl: string;
    redisUrl: string;
  }
}

// apps/worker/test/global-setup.ts -> repo root.
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/**
 * Runs once per Vitest worker, before any integration test file in that
 * worker executes. Starts one Postgres, one RabbitMQ, and one Redis
 * container, migrates the database, and publishes all three connection
 * URLs via `provide()` so test files read them with `inject()` (see
 * test/harness.ts). Every container is torn down in the returned teardown
 * function. Mirrors `apps/api/test/global-setup.ts`; Redis joined
 * RabbitMQ here in Task 5, once the aggregation consumer's cache
 * invalidation needed something real to invalidate against.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const [postgres, rabbitmq, redis]: [StartedPostgreSqlContainer, StartedRabbitMQContainer, StartedRedisContainer] =
    await Promise.all([
      new PostgreSqlContainer('postgres:17-alpine').start(),
      new RabbitMQContainer('rabbitmq:4-management-alpine').start(),
      new RedisContainer('redis:7-alpine').start(),
    ]);

  const databaseUrl = postgres.getConnectionUri();
  const rabbitmqUrl = rabbitmq.getAmqpUrl();
  const redisUrl = redis.getConnectionUrl();

  execFileSync('pnpm', ['--filter', '@reviews/db', 'run', 'db:migrate'], {
    cwd: REPO_ROOT,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'inherit',
  });

  project.provide('databaseUrl', databaseUrl);
  project.provide('rabbitmqUrl', rabbitmqUrl);
  project.provide('redisUrl', redisUrl);

  return async () => {
    await Promise.all([postgres.stop(), rabbitmq.stop(), redis.stop()]);
  };
}
