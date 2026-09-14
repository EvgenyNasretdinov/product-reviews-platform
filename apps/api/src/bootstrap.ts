import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { cleanupOpenApiDoc } from 'nestjs-zod';
import { PrismaExceptionFilter } from './common/filters/prisma-exception.filter.js';
import { APP_ENV } from './config/config.module.js';
import type { AppEnv } from './config/env.js';

/**
 * Configures the pipes, filters, prefix, CORS policy, and published OpenAPI
 * document shared by the running service (main.ts) and every integration
 * test (test/harness.ts).
 *
 * Keeping this in one function is what makes the integration suite honest:
 * a test that skipped the global ValidationPipe, the Prisma exception
 * filter, or the Swagger setup would be exercising a different application
 * than the one that actually ships — see test/openapi.integration.test.ts,
 * which depends on `/docs-json` existing in exactly this app.
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
  configureOpenApi(app);
}

/**
 * Publishes the OpenAPI document at `/docs` (Swagger UI) and `/docs-json`
 * (the raw document). Neither path sits under `setGlobalPrefix`'s
 * `api/v1` — `SwaggerModule.setup` only applies the global prefix when
 * `useGlobalPrefix` is explicitly set, which this deliberately leaves
 * unset, so the docs stay reachable at a fixed, version-independent URL.
 *
 * Request and response schemas come from `createZodDto` (`nestjs-zod`)
 * wrapping the same Zod schemas from `@reviews/contracts` that the
 * controllers already validate against by hand (see, e.g.,
 * `auth/dto/auth.dto.ts`) — not a parallel set of `@ApiProperty`-annotated
 * classes, which is how this document stays unable to drift from what the
 * runtime actually enforces. `cleanupOpenApiDoc` is nestjs-zod's own
 * required post-processing step (renames/dereferences the JSON-Schema
 * output its `_OPENAPI_METADATA_FACTORY` produces into valid OpenAPI) —
 * skipping it is a documented way to end up with a malformed document.
 */
function configureOpenApi(app: INestApplication): void {
  const config = new DocumentBuilder()
    .setTitle('Product Reviews Platform API')
    .setDescription(
      'HTTP surface for the product reviews platform: catalogue browsing, ' +
        'review submission/moderation, and helpfulness voting. Reviews are ' +
        'moderated asynchronously — see the design document at ' +
        '`docs/design/2026-09-13-product-reviews-design.md` in this ' +
        'repository for the full system design; this document describes ' +
        'only the HTTP surface it implements.',
    )
    .setVersion('1.0')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'bearer')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, cleanupOpenApiDoc(document));
}
