import { createParamDecorator, type ExecutionContext, UnauthorizedException } from '@nestjs/common';
import type { Role } from '@reviews/db';
import type { Request } from 'express';

/** The claims a valid JWT decodes into — see JwtStrategy#validate. */
export interface AuthenticatedUser {
  id: string;
  email: string;
  role: Role;
}

// Passport (via @types/passport) declares `Express.User` as an empty
// interface and `Express.Request#user?: Express.User`. Merging our shape
// into it here is what lets every handler read `request.user` with real
// types instead of `any`, without redeclaring Request ourselves.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- declaration merging: adds AuthenticatedUser's members onto passport's Express.User
    interface User extends AuthenticatedUser {}
  }
}

/**
 * Injects the authenticated user's JWT claims into a handler parameter.
 * Only meaningful behind the global `JwtAuthGuard` (or a route explicitly
 * running passport's jwt strategy), which is what populates `request.user`.
 * Throws if that guard did not run — a decorator that silently returned
 * `undefined` would let a handler NPE instead of failing loudly.
 */
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthenticatedUser => {
  const request = ctx.switchToHttp().getRequest<Request>();
  if (!request.user) {
    throw new UnauthorizedException('No authenticated user on request');
  }
  return request.user;
});
