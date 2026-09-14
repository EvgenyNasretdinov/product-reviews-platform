import type { Prisma } from '@reviews/db';
import { describe, expect, it } from 'vitest';
import { OutboxRepository } from './outbox.repository.js';

/**
 * `claimBatch`'s `ORDER BY id` cannot be proven load-bearing by seeding
 * rows and asserting delivery order against a real Postgres: this
 * schema's `outbox_unpublished_idx` partial index makes the planner pick
 * a Bitmap Heap Scan for the claim query regardless of whether `ORDER BY
 * id` is present, and — verified empirically, both for plain sequential
 * inserts and for rows deliberately finalised via `UPDATE` in reverse id
 * order to try to force heap disorder — the scan's output still came
 * back in id order either way. So this asserts the mechanism directly:
 * the exact SQL text `claimBatch` sends contains the clause. Removing it
 * from `outbox.repository.ts` fails this test immediately and
 * deterministically, which a data-driven integration test could not do
 * here.
 */
describe('OutboxRepository.claimBatch', () => {
  it('claims with an explicit ORDER BY id', async () => {
    let capturedStrings: TemplateStringsArray | undefined;
    const fakeTx = {
      $queryRaw: (strings: TemplateStringsArray): Promise<unknown[]> => {
        capturedStrings = strings;
        return Promise.resolve([]);
      },
    } as unknown as Prisma.TransactionClient;

    const repository = new OutboxRepository({} as never);
    await repository.claimBatch(fakeTx, 50, 5);

    if (!capturedStrings) throw new Error('claimBatch did not call tx.$queryRaw');
    expect(capturedStrings.join('')).toContain('ORDER BY id');
  });
});
