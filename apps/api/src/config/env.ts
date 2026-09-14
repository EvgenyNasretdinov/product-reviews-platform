import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().positive(),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  RABBITMQ_URL: z.string().url(),
  JWT_SECRET: z.string().min(32),
  JWT_EXPIRES_IN: z.string().min(1),
  // Reviews per author per hour; see docs/design for the exact window.
  REVIEW_SUBMIT_RATE_LIMIT: z.coerce.number().int().positive().default(5),
});

export interface AppEnv {
  nodeEnv: 'development' | 'test' | 'production';
  apiPort: number;
  databaseUrl: string;
  redisUrl: string;
  rabbitmqUrl: string;
  jwtSecret: string;
  jwtExpiresIn: string;
  reviewSubmitRateLimit: number;
}

/**
 * Parses and validates the process environment through a single Zod schema.
 *
 * On failure every invalid variable is reported in one thrown Error rather
 * than only the first one Zod encounters, so a misconfigured deployment
 * fails once with a full list instead of one restart per typo.
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
    apiPort: env.API_PORT,
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
    rabbitmqUrl: env.RABBITMQ_URL,
    jwtSecret: env.JWT_SECRET,
    jwtExpiresIn: env.JWT_EXPIRES_IN,
    reviewSubmitRateLimit: env.REVIEW_SUBMIT_RATE_LIMIT,
  };
}
