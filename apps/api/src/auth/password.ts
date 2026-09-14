import * as argon2 from 'argon2';

/**
 * Hashes a plaintext password with argon2id, the variant argon2's own docs
 * recommend for password storage (resistant to both GPU and side-channel
 * attacks). Each call produces a different hash for the same input because
 * argon2 embeds a fresh random salt.
 */
export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, { type: argon2.argon2id });
}

/**
 * Verifies a plaintext password against a stored hash.
 *
 * argon2.verify throws on a malformed/corrupt hash rather than returning
 * false, which would otherwise let a bad row crash a login request instead
 * of just failing it. Callers (notably AuthService, for its timing-safety
 * dummy-hash comparison) rely on this never throwing.
 */
export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}
