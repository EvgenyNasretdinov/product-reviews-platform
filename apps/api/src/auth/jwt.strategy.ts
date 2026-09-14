import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { roleSchema } from '@reviews/contracts';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { APP_ENV } from '../config/config.module.js';
import type { AppEnv } from '../config/env.js';
import type { AuthenticatedUser } from './decorators/current-user.decorator.js';

/** The shape AuthService.login signs into the JWT payload. */
interface JwtPayload {
  sub: string;
  email: string;
  role: string;
}

/**
 * Verifies the bearer token's signature and expiry (passport-jwt itself,
 * before `validate` ever runs — a token signed with a different secret, or
 * an expired one, is rejected with 401 without reaching this class), then
 * maps the payload onto {@link AuthenticatedUser}.
 *
 * Deliberately does not re-query the database on every request: the token
 * is the session, and its claims (id, email, role) are what
 * `@CurrentUser()` hands to every guarded handler.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(@Inject(APP_ENV) env: AppEnv) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: env.jwtSecret,
      // Without an explicit allow-list, jsonwebtoken defaults to accepting
      // any HMAC algorithm (HS256/HS384/HS512) for a string secret. That
      // happens to be safe today, but it's a library default rather than a
      // stated intention, and defaults are not a contract across majors.
      // Pinning to the one algorithm the signing side actually uses closes
      // that off explicitly. Must match the `algorithm` set in
      // AuthModule's JwtModule.registerAsync signOptions.
      algorithms: ['HS256'],
    });
  }

  validate(payload: JwtPayload): AuthenticatedUser {
    const role = roleSchema.safeParse(payload.role);
    if (!role.success || !payload.sub || !payload.email) {
      throw new UnauthorizedException('Malformed token payload');
    }
    return { id: payload.sub, email: payload.email, role: role.data };
  }
}
