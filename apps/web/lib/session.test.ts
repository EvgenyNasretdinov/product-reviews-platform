import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));

vi.mock('next/headers', () => ({
  cookies: vi.fn(() => Promise.resolve({ get: getMock })),
}));

const { getServerSession, getServerToken } = await import('./session');

const VALID_USER = {
  id: '11111111-1111-1111-1111-111111111111',
  email: 'alice@example.com',
  displayName: 'Alice Anderson',
  role: 'CUSTOMER',
};

describe('session', () => {
  beforeEach(() => {
    getMock.mockReset();
  });

  it('returns null when the cookie is missing', async () => {
    getMock.mockReturnValue(undefined);

    await expect(getServerSession()).resolves.toBeNull();
    await expect(getServerToken()).resolves.toBeNull();
  });

  it('returns null when the cookie is not valid JSON', async () => {
    getMock.mockReturnValue({ value: 'not-json{{{' });

    await expect(getServerSession()).resolves.toBeNull();
  });

  it('returns null when the cookie is valid JSON but does not match the session shape', async () => {
    getMock.mockReturnValue({ value: JSON.stringify({ token: 'abc' }) });

    await expect(getServerSession()).resolves.toBeNull();
  });

  it('returns the parsed user for a valid cookie', async () => {
    getMock.mockReturnValue({ value: JSON.stringify({ token: 'tok-123', user: VALID_USER }) });

    await expect(getServerSession()).resolves.toEqual(VALID_USER);
  });

  it('returns the token for a valid cookie', async () => {
    getMock.mockReturnValue({ value: JSON.stringify({ token: 'tok-123', user: VALID_USER }) });

    await expect(getServerToken()).resolves.toBe('tok-123');
  });
});
