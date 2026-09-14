import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule, type JwtSignOptions } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { APP_ENV } from '../config/config.module.js';
import type { AppEnv } from '../config/env.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { JwtAuthGuard } from './guards/jwt-auth.guard.js';
import { JwtStrategy } from './jwt.strategy.js';

/**
 * Wires JWT sessions and registers `JwtAuthGuard` as the *global* guard via
 * `APP_GUARD` — every route in the application is authenticated unless it
 * carries `@Public()`. This is deliberately an opt-out, not an opt-in: a
 * new controller that forgets to think about auth is private by default,
 * not silently open.
 */
@Module({
  imports: [
    PassportModule,
    JwtModule.registerAsync({
      inject: [APP_ENV],
      useFactory: (env: AppEnv) => ({
        secret: env.jwtSecret,
        // env.jwtExpiresIn is validated by envSchema as a non-empty string
        // (e.g. "12h"), not narrowed to jsonwebtoken's `StringValue`
        // template-literal type — that type exists to catch a *literal*
        // typo at compile time, which doesn't apply to a value read from
        // the environment. jsonwebtoken parses it with `ms()` at runtime
        // regardless of this cast.
        signOptions: { expiresIn: env.jwtExpiresIn as JwtSignOptions['expiresIn'] },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy, { provide: APP_GUARD, useClass: JwtAuthGuard }],
  exports: [AuthService],
})
export class AuthModule {}
