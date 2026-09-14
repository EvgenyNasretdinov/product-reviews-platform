import { describe, expect, it } from 'vitest';
import { loadEnv } from './env.js';

const valid = {
  NODE_ENV: 'test',
  API_PORT: '3001',
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  RABBITMQ_URL: 'amqp://guest:guest@localhost:5672',
  JWT_SECRET: 'x'.repeat(32),
  JWT_EXPIRES_IN: '12h',
};

describe('loadEnv', () => {
  it('parses a valid environment and coerces the port to a number', () => {
    expect(loadEnv(valid).apiPort).toBe(3001);
  });

  it('rejects a JWT secret shorter than 32 characters', () => {
    expect(() => loadEnv({ ...valid, JWT_SECRET: 'short' })).toThrow(/JWT_SECRET/);
  });

  it('reports every invalid variable at once', () => {
    expect(() => loadEnv({ ...valid, API_PORT: 'nope', REDIS_URL: 'not-a-url' })).toThrow(/API_PORT[\s\S]*REDIS_URL/);
  });

  it('rejects a JWT_EXPIRES_IN that jsonwebtoken/ms cannot parse', () => {
    // A misconfigured value here must fail at boot (this test), not on the
    // first login attempt — jsonwebtoken's sign() only discovers a bad
    // expiresIn when it actually tries to use it.
    expect(() => loadEnv({ ...valid, JWT_EXPIRES_IN: 'not-a-duration' })).toThrow(/JWT_EXPIRES_IN/);
  });

  it('accepts a plain-number JWT_EXPIRES_IN and one with a unit suffix', () => {
    expect(loadEnv({ ...valid, JWT_EXPIRES_IN: '3600' }).jwtExpiresIn).toBe('3600');
    expect(loadEnv({ ...valid, JWT_EXPIRES_IN: '7d' }).jwtExpiresIn).toBe('7d');
  });
});
