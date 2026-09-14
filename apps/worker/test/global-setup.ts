import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RabbitMQContainer, type StartedRabbitMQContainer } from '@testcontainers/rabbitmq';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
    rabbitmqUrl: string;
  }
}

// apps/worker/test/global-setup.ts -> repo root.
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/**
 * Runs once per Vitest worker, before any integration test file in that
 * worker executes. Starts one Postgres and one RabbitMQ container,
 * migrates the database, and publishes both connection URLs via
 * `provide()` so test files read them with `inject()` (see
 * test/harness.ts). Both containers are torn down in the returned
 * teardown function. Mirrors `apps/api/test/global-setup.ts`, with
 * RabbitMQ in place of Redis since this worker's tests exercise the
 * broker, not the cache.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const [postgres, rabbitmq]: [StartedPostgreSqlContainer, StartedRabbitMQContainer] = await Promise.all([
    new PostgreSqlContainer('postgres:17-alpine').start(),
    new RabbitMQContainer('rabbitmq:4-management-alpine').start(),
  ]);

  const databaseUrl = postgres.getConnectionUri();
  const rabbitmqUrl = rabbitmq.getAmqpUrl();

  execFileSync('pnpm', ['--filter', '@reviews/db', 'run', 'db:migrate'], {
    cwd: REPO_ROOT,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'inherit',
  });

  project.provide('databaseUrl', databaseUrl);
  project.provide('rabbitmqUrl', rabbitmqUrl);

  return async () => {
    await Promise.all([postgres.stop(), rabbitmq.stop()]);
  };
}
