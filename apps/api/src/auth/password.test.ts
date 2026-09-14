import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './password.js';

describe('password hashing', () => {
  it('verifies a correct password', async () => {
    const hash = await hashPassword('password123');
    expect(await verifyPassword(hash, 'password123')).toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const hash = await hashPassword('password123');
    expect(await verifyPassword(hash, 'password124')).toBe(false);
  });

  it('produces a different hash for the same password', async () => {
    expect(await hashPassword('password123')).not.toBe(await hashPassword('password123'));
  });

  it('returns false rather than throwing on a corrupt hash', async () => {
    expect(await verifyPassword('not-a-hash', 'password123')).toBe(false);
  });
});
