import { SetMetadata } from '@nestjs/common';
import type { Role } from '@reviews/db';

/**
 * Restricts a handler to the listed roles. Read by {@link RolesGuard}, which
 * compares this metadata against `request.user.role` set by the JWT
 * strategy. Has no effect unless the route also runs RolesGuard — the two
 * are applied together at the controller/method level (see Task 14's
 * moderation routes), on top of the always-on global JwtAuthGuard.
 */
export const ROLES_KEY = 'roles';
export const Roles = (...roles: Role[]): MethodDecorator & ClassDecorator => SetMetadata(ROLES_KEY, roles);
