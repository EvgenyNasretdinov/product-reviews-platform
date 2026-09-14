import { Global, Module } from '@nestjs/common';
import { loadEnv } from './env.js';

/** DI token for the validated {@link AppEnv} singleton. */
export const APP_ENV = Symbol('APP_ENV');

/**
 * Parses `process.env` through {@link loadEnv} once and publishes the result
 * as a global provider, so every module injects the same validated
 * configuration instead of reading `process.env` (and re-validating it) on
 * its own. Mirrors `apps/api/src/config/config.module.ts`.
 */
@Global()
@Module({
  providers: [{ provide: APP_ENV, useFactory: () => loadEnv(process.env) }],
  exports: [APP_ENV],
})
export class ConfigModule {}
