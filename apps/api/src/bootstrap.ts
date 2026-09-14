import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { PrismaExceptionFilter } from './common/filters/prisma-exception.filter.js';
import { APP_ENV } from './config/config.module.js';
import type { AppEnv } from './config/env.js';

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
  const env = app.get<AppEnv>(APP_ENV);

  app.setGlobalPrefix('api/v1');
  app.enableCors({ origin: env.webOrigin, credentials: true });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new PrismaExceptionFilter());
}
