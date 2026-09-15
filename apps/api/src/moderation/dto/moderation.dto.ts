import { moderationDecisionInputSchema } from '@reviews/contracts';
import { createZodDto } from 'nestjs-zod';
import { moderationQueueSchema } from '../moderation.service.js';

// See auth/dto/auth.dto.ts for why these classes exist and why the
// controller never constructs them.
export class ModerationDecisionRequestDto extends createZodDto(moderationDecisionInputSchema) {}

// `moderationQueueSchema` (`paginatedSchema(moderationReviewDtoSchema)` —
// `ReviewDto` plus the `product` it's about) is imported from the service
// rather than redefined here — the same pattern as
// products/dto/products.dto.ts's `ProductListResponseDto`. Deriving the
// OpenAPI schema from that Zod schema via `createZodDto` is also what
// keeps this DTO's generated shape (and therefore /docs-json) in sync
// automatically whenever `moderationReviewDtoSchema` changes — there is no
// separate, hand-written property list here that could drift from it.
export class ModerationQueueResponseDto extends createZodDto(moderationQueueSchema) {}
