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
const cursorPayloadSchema = z.object({
  key: z.string().min(1),
  id: z.string().min(1),
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
