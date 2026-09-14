import { SetMetadata } from '@nestjs/common';

/**
 * Marks a handler (or an entire controller) as exempt from the globally
 * registered {@link JwtAuthGuard}.
 *
 * Authentication is enforced as a global guard, not opted into per
 * controller, precisely so that a new endpoint is private by default:
 * forgetting to decorate it fails closed (401) rather than open. This
 * decorator is the one deliberate, explicit opt-out.
 */
export const IS_PUBLIC_KEY = 'isPublic';
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);
