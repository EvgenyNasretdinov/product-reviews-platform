import { loginInputSchema, sessionUserDtoSchema } from '@reviews/contracts';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * OpenAPI-only wrappers around the shared Zod contracts from
 * `@reviews/contracts`: each class exists purely so `@nestjs/swagger`
 * (via nestjs-zod's `_OPENAPI_METADATA_FACTORY`) can read a schema
 * straight off the exact validator the controller already parses the
 * request with — see AuthController#login and #me, which keep calling
 * `schema.safeParse()`/returning the service's own DTO directly and never
 * construct one of these classes. Nothing about request handling changes;
 * only what `/docs-json` describes does. Every controller's `dto/` folder
 * in this app follows this same pattern.
 */
export class LoginRequestDto extends createZodDto(loginInputSchema) {}
export class SessionUserResponseDto extends createZodDto(sessionUserDtoSchema) {}

// AuthService#login's `LoginResult` isn't itself a `@reviews/contracts`
// schema (it's an api-local interface: `{ accessToken, user }`), so this
// wraps `sessionUserDtoSchema` — the one piece of it that is — rather than
// inventing a parallel, hand-maintained shape for the whole response.
const loginResponseSchema = z.object({ accessToken: z.string(), user: sessionUserDtoSchema });
export class LoginResponseDto extends createZodDto(loginResponseSchema) {}
