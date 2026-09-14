import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';

/**
 * Opaque keyset-pagination cursor.
 *
 * Offset pagination ("skip N rows") repeats or drops rows whenever the
 * underlying list changes between requests, which for a review list under
 * active voting and moderation is constantly. A cursor instead encodes the
 * exact position to resume from: the sort key's value and the row id (a
 * tiebreaker for rows that share a key), so the next page starts precisely
 * after the last row the client saw.
 *
 * The cursor also embeds the `scope` it was produced under (e.g. the sort
 * order for the review list, or a fixed scope for the product list). The
 * same key value means different things under different sorts -- a
 * helpful-count of 3 is not a rating of 3 -- so a cursor minted under one
 * scope must never be replayed against another; decodeCursor rejects that
 * with a 400 instead of silently returning an arbitrary slice of the list.
 *
 * The wire format is base64url of a small JSON payload rather than a
 * readable composite, so the sort key can change later without becoming a
 * public API contract.
 */
// `id` is validated as a UUID, not just a non-empty string: every cursor
// producer in this codebase mints it from a row's own `id` column, which is
// `@db.Uuid` in every table a cursor paginates (products, reviews). A
// syntactically-valid-JSON cursor carrying a non-UUID id would otherwise
// reach that column as a Postgres `::uuid` comparison and raise `P2023`,
// which the global exception filter doesn't map — a public, unauthenticated
// listing endpoint would 500 on attacker-controlled input instead of
// answering the 400 a malformed cursor actually warrants.
const cursorPayloadSchema = z.object({
  key: z.string().min(1),
  id: z.string().uuid(),
  scope: z.string().min(1),
});

export function encodeCursor(key: string | number, id: string, scope: string): string {
  const payload = { key: String(key), id, scope };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string, expectedScope: string): { key: string; id: string } {
  try {
    const json = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed = cursorPayloadSchema.parse(JSON.parse(json));

    if (parsed.scope !== expectedScope) {
      throw new Error('scope mismatch');
    }

    return { key: parsed.key, id: parsed.id };
  } catch {
    throw new BadRequestException('invalid cursor');
  }
}

/**
 * Parses a cursor key as the number a numeric-column cursor (review
 * `helpfulCount`/`rating`) must carry. `decodeCursor` only checks that the
 * key is a non-empty string — scope is what it validates — so a cursor with
 * a correct, matching scope but a garbage key (`"abc"`) still has to be
 * rejected here, with the same `BadRequestException` a scope mismatch gets.
 * Left unchecked, `Number()` would hand Prisma a `NaN` bound, which reaches
 * Postgres, misses every known-error branch in the global exception filter,
 * and 500s — for a public endpoint taking attacker-controlled query-string
 * input, that is exactly the "arbitrary server error instead of a clean
 * client error" outcome the scope check exists to avoid.
 *
 * Shared by every repository that paginates by a numeric or date column
 * (`ReviewsRepository`, `ProductsRepository`) — see {@link parseCursorDate}
 * for the date-column counterpart, and this file's own header comment for
 * why both live alongside the cursor codec rather than in either
 * repository.
 */
export function parseCursorNumber(key: string): number {
  const value = Number(key);
  if (Number.isNaN(value)) {
    throw new BadRequestException('invalid cursor');
  }
  return value;
}

/** As {@link parseCursorNumber}, for a `createdAt`-column cursor's date key. */
export function parseCursorDate(key: string): Date {
  const value = new Date(key);
  if (Number.isNaN(value.getTime())) {
    throw new BadRequestException('invalid cursor');
  }
  return value;
}
