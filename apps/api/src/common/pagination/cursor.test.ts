import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor } from './cursor.js';

describe('cursor codec', () => {
  it('round-trips a key and an id', () => {
    const cursor = encodeCursor(42, '0193a6f0-0000-7000-8000-000000000001', 'products');
    expect(decodeCursor(cursor, 'products')).toEqual({
      key: '42',
      id: '0193a6f0-0000-7000-8000-000000000001',
    });
  });

  it('produces url-safe output', () => {
    const cursor = encodeCursor(
      '2026-09-13T10:00:00.000Z',
      '0193a6f0-0000-7000-8000-000000000001',
      'newest',
    );
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it.each(['', 'not-base64!', Buffer.from('{"key":"a"}').toString('base64url')])(
    'rejects malformed cursor %s',
    (bad) => {
      expect(() => decodeCursor(bad, 'products')).toThrow(BadRequestException);
    },
  );

  it('rejects a cursor decoded against a different scope than it was encoded with', () => {
    const cursor = encodeCursor(3, '0193a6f0-0000-7000-8000-000000000001', 'rating_desc');
    expect(() => decodeCursor(cursor, 'helpful')).toThrow(BadRequestException);
  });

  it('rejects a scope-mismatched cursor with a BadRequestException, not a generic throw', () => {
    const cursor = encodeCursor(3, '0193a6f0-0000-7000-8000-000000000001', 'products');
    try {
      decodeCursor(cursor, 'reviews');
      expect.unreachable('decodeCursor should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
    }
  });
});
