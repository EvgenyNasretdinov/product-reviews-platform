import { ForbiddenException, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ROLES_KEY } from '../decorators/roles.decorator.js';

/**
 * Reads the `@Roles(...)` metadata a handler (or controller) was decorated
 * with and compares it against `request.user.role`.
 *
 * Runs strictly after the global `JwtAuthGuard`, which is what populates
 * `request.user` in the first place — a route using `@Roles()` without also
 * being behind that guard would always see `request.user` as `undefined`
 * and be rejected, never silently allowed.
 *
 * Not registered globally: a route opts into role restriction explicitly
 * with `@UseGuards(RolesGuard)` plus `@Roles(...)`, since most authenticated
 * routes have no role restriction at all.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const role = request.user?.role;
    if (!role || !requiredRoles.includes(role)) {
      throw new ForbiddenException('Insufficient role for this resource');
    }
    return true;
  }
}
