import { z } from 'zod';

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  RABBITMQ_URL: z.string().url(),
});

export interface AppEnv {
  nodeEnv: 'development' | 'test' | 'production';
  rabbitmqUrl: string;
}

/**
 * Parses and validates the process environment through a single Zod schema.
 *
 * On failure every invalid variable is reported in one thrown Error rather
 * than only the first one Zod encounters, so a misconfigured deployment
 * fails once with a full list instead of one restart per typo. Mirrors
 * `apps/api/src/config/env.ts`; this worker's own env grows in later
 * tasks (database, cache, outbox-relay tuning) as those pieces land.
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
    rabbitmqUrl: env.RABBITMQ_URL,
  };
}
