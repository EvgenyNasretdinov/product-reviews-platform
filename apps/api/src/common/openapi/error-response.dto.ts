import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * The shape every error response on this API actually takes: Nest's
 * built-in `HttpException#getResponse()` (thrown by
 * `BadRequestException`/`UnauthorizedException`/etc. across every
 * controller) and `PrismaExceptionFilter`'s two mapped Prisma codes (see
 * common/filters/prisma-exception.filter.ts) both produce
 * `{ statusCode, message }`, with `message` a single string for a
 * hand-thrown exception or a string array for class-validator-style
 * aggregated errors, and `error` present only for Nest's default
 * exceptions (e.g. `"Bad Request"`).
 *
 * A schema, not a hand-maintained interface, for the same reason every
 * other DTO in this module is one: `createZodDto` is what lets
 * `@nestjs/swagger` read this straight off the class via nestjs-zod's
 * `_OPENAPI_METADATA_FACTORY`, so the documented error body cannot drift
 * from a plain object literal nobody remembers to update.
 */
export const errorResponseSchema = z.object({
  statusCode: z.number().int(),
  message: z.union([z.string(), z.array(z.string())]),
  error: z.string().optional(),
});

export class ErrorResponseDto extends createZodDto(errorResponseSchema) {}
