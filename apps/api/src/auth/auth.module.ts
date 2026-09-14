import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
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
        // env.jwtExpiresIn is validated by envSchema against jsonwebtoken's
        // own `ms()` parser (see config/env.ts), so it's already typed as
        // `ms.StringValue` here — no cast needed.
        //
        // `algorithm` must match JwtStrategy's `algorithms` allow-list
        // (jwt.strategy.ts): pinning both sides to HS256 explicitly, rather
        // than relying on jsonwebtoken's default HMAC-family allow-list on
        // the verify side, means the accepted algorithm is a stated
        // intention instead of an implicit library default.
        signOptions: { expiresIn: env.jwtExpiresIn, algorithm: 'HS256' },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy, { provide: APP_GUARD, useClass: JwtAuthGuard }],
  exports: [AuthService],
})
export class AuthModule {}
