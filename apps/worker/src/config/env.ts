import { z } from 'zod';

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().url(),
  RABBITMQ_URL: z.string().url(),
  // Outbox relay tuning (Task 2). All three default so a bare RABBITMQ_URL +
  // DATABASE_URL is still enough to boot in development; production can
  // tighten them without a code change.
  OUTBOX_BATCH_SIZE: z.coerce.number().int().positive().default(50),
  OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(500),
});

export interface AppEnv {
  nodeEnv: 'development' | 'test' | 'production';
  databaseUrl: string;
  rabbitmqUrl: string;
  outboxBatchSize: number;
  outboxMaxAttempts: number;
  outboxPollIntervalMs: number;
}

/**
 * Parses and validates the process environment through a single Zod schema.
 *
 * On failure every invalid variable is reported in one thrown Error rather
 * than only the first one Zod encounters, so a misconfigured deployment
 * fails once with a full list instead of one restart per typo. Mirrors
 * `apps/api/src/config/env.ts`; this worker's own env grows in later
 * tasks (cache) as those pieces land.
 */
export function loadEnv(source: NodeJS.ProcessEnv): AppEnv {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const message = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('\n');
    throw new Error(message);
  }

  const env = result.data;
  return {
    nodeEnv: env.NODE_ENV,
    databaseUrl: env.DATABASE_URL,
    rabbitmqUrl: env.RABBITMQ_URL,
    outboxBatchSize: env.OUTBOX_BATCH_SIZE,
    outboxMaxAttempts: env.OUTBOX_MAX_ATTEMPTS,
    outboxPollIntervalMs: env.OUTBOX_POLL_INTERVAL_MS,
  };
}
