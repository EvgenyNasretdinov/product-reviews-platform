import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// HealthController's response bodies are api-local shapes (`{ status,
// uptime }` / `ReadinessBody`), not `@reviews/contracts` schemas — there's
// nothing here for a shared contract to own, since no other service or
// client depends on this shape the way the catalogue/review DTOs do. Still
// expressed as Zod, and still only ever used for documentation (see
// auth/dto/auth.dto.ts), for the same reason `reviews/dto/votes.dto.ts`
// restates `VoteCounts` as Zod: consistency with every other response in
// this document, not because the runtime validates against it.
const dependencyStatusSchema = z.enum(['up', 'down']);

export const livenessResponseSchema = z.object({
  status: z.literal('ok'),
  uptime: z.number(),
});
export class LivenessResponseDto extends createZodDto(livenessResponseSchema) {}

export const readinessResponseSchema = z.object({
  status: z.enum(['ok', 'error']),
  checks: z.object({
    database: dependencyStatusSchema,
    cache: dependencyStatusSchema,
  }),
});
export class ReadinessResponseDto extends createZodDto(readinessResponseSchema) {}
