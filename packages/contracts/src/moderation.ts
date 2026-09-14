import { z } from 'zod';

export const moderationDecisionInputSchema = z.object({
  decision: z.enum(['APPROVED', 'REJECTED']),
  reason: z.string().nullable(),
});
export type ModerationDecisionInput = z.infer<typeof moderationDecisionInputSchema>;
