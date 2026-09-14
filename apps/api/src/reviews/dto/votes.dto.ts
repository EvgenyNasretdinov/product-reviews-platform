import { voteValueSchema } from '@reviews/contracts';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * The body `VotesController#vote` parses through `.safeParse()` — the same
 * reason `ReviewsController#submit` parses `@Body() body: unknown` through
 * `createReviewInputSchema` (see auth/dto/auth.dto.ts for the general
 * pattern). Defined here, in the `dto/` module, rather than in
 * `votes.controller.ts` itself: the controller already imports
 * `CastVoteRequestDto` from this file for its `@ApiBody`, so putting the
 * schema in the controller and importing it back here would make the two
 * modules import each other — a circular import that, under this app's
 * ESM/Vite module graph, resolved with `castVoteInputSchema` still
 * `undefined` on the side evaluated first (the class field capturing it
 * genuinely undefined, not a build-order fluke) and crashed
 * `SwaggerModule.createDocument` on every single run. One direction only:
 * the controller imports the schema from here.
 */
export const castVoteInputSchema = z.object({ value: voteValueSchema });
export class CastVoteRequestDto extends createZodDto(castVoteInputSchema) {}

// `VotesService#castVote` returns `VoteCounts` (reviews.repository.ts), an
// api-local interface rather than a `@reviews/contracts` schema — this is
// the same interface's shape restated as Zod, the one place in this file
// that isn't imported from an existing schema, because there is no
// existing Zod schema for it to import.
const voteCountsSchema = z.object({
  helpfulCount: z.number().int().nonnegative(),
  notHelpfulCount: z.number().int().nonnegative(),
});
export class VoteCountsResponseDto extends createZodDto(voteCountsSchema) {}
