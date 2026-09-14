import { moderationDecisionInputSchema } from '@reviews/contracts';
import { createZodDto } from 'nestjs-zod';
import { moderationQueueSchema } from '../moderation.service.js';

// See auth/dto/auth.dto.ts for why these classes exist and why the
// controller never constructs them.
export class ModerationDecisionRequestDto extends createZodDto(moderationDecisionInputSchema) {}

// `moderationQueueSchema` (`paginatedSchema(reviewDtoSchema)`) is imported
// from the service rather than redefined here — the same pattern as
// products/dto/products.dto.ts's `ProductListResponseDto`.
export class ModerationQueueResponseDto extends createZodDto(moderationQueueSchema) {}
