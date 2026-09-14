import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor, parseCursorDate, parseCursorNumber } from './cursor.js';

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

  // A validly-scoped cursor whose `id` isn't a UUID would otherwise reach a
  // `@db.Uuid` column comparison and raise Prisma's unmapped P2023 (500) —
  // see products.repository.ts and reviews.repository.ts, both of which
  // compare a cursor's `id` against a `@db.Uuid` column.
  it('rejects a cursor whose id is not a UUID', () => {
    const cursor = encodeCursor(42, 'not-a-uuid', 'products');
    expect(() => decodeCursor(cursor, 'products')).toThrow(BadRequestException);
  });
});

describe('parseCursorNumber', () => {
  it('parses a numeric key', () => {
    expect(parseCursorNumber('42')).toBe(42);
  });

  // The bug this guards against: an unvalidated `Number()` on a garbage key
  // hands Prisma a `NaN` bound, which reaches Postgres and misses every
  // known-error branch in the global exception filter — an unmapped 500 on
  // a public, attacker-controlled listing endpoint.
  it('rejects a non-numeric key with a BadRequestException', () => {
    expect(() => parseCursorNumber('not-a-number')).toThrow(BadRequestException);
  });
});

describe('parseCursorDate', () => {
  it('parses an ISO date key', () => {
    const parsed = parseCursorDate('2026-09-13T10:00:00.000Z');
    expect(parsed).toBeInstanceOf(Date);
    expect(parsed.toISOString()).toBe('2026-09-13T10:00:00.000Z');
  });

  // The bug this guards against: `new Date('not-a-date')` is an Invalid
  // Date, not a thrown error — left unchecked it reaches Prisma's
  // serialiser and throws `RangeError: Invalid time value`, which the
  // global exception filter doesn't map, 500ing a public endpoint on
  // attacker-controlled input (`ProductsRepository.list`'s CRITICAL bug).
  it('rejects an unparseable date key with a BadRequestException', () => {
    expect(() => parseCursorDate('not-a-date')).toThrow(BadRequestException);
  });
});
