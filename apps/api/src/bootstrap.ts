import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { PrismaExceptionFilter } from './common/filters/prisma-exception.filter.js';

// The web app runs against Next.js's own default dev port. There is no
// dedicated env var for this: AppEnv's shape is fixed by the config
// contract (nodeEnv, apiPort, databaseUrl, redisUrl, rabbitmqUrl, jwtSecret,
// jwtExpiresIn, reviewSubmitRateLimit), and the API only ever needs to
// *permit* the browser's origin, never to read its own.
const WEB_ORIGIN = 'http://localhost:3000';

/**
 * Configures the pipes, filters, prefix, and CORS policy shared by the
 * running service (main.ts) and every integration test (test/harness.ts).
 *
 * Keeping this in one function is what makes the integration suite honest:
 * a test that skipped the global ValidationPipe or the Prisma exception
 * filter would be exercising a different application than the one that
 * actually ships.
 */
export function configureApp(app: INestApplication): void {
  app.setGlobalPrefix('api/v1');
  app.enableCors({ origin: WEB_ORIGIN, credentials: true });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new PrismaExceptionFilter());
}
