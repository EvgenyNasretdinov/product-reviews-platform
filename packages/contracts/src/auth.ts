import { z } from 'zod';

export const roleSchema = z.enum(['CUSTOMER', 'MODERATOR']);
export type Role = z.infer<typeof roleSchema>;

export const loginInputSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
export type LoginInput = z.infer<typeof loginInputSchema>;

export const sessionUserDtoSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  displayName: z.string(),
  role: roleSchema,
});
export type SessionUserDto = z.infer<typeof sessionUserDtoSchema>;
