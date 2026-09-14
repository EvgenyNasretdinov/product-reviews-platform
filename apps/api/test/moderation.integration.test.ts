import type { Review, ReviewStatus } from '@reviews/db';
import type { ReviewDto } from '@reviews/contracts';
import { describe, expect, it } from 'vitest';
import { createProduct, createReview, createUser } from './fixtures.js';
import { setupTestApp } from './harness.js';

// supertest's Response#body is typed `any`; narrow it through this shape
// once instead of sprinkling eslint-disable comments at each access.
interface ModerationQueueBody {
  items: ReviewDto[];
  nextCursor: string | null;
}

const ctx = setupTestApp();

/** Creates a fresh product and one review on it in `status`, authored by a fresh user. */
async function seedReview(
  status: ReviewStatus,
  overrides: { title?: string; body?: string; authorDisplayName?: string } = {},
): Promise<{ review: Review; productId: string; authorId: string }> {
  const author = await createUser(ctx.prisma, { displayName: overrides.authorDisplayName ?? 'Queue Author' });
  const product = await createProduct(ctx.prisma);
  const review = await createReview(ctx.prisma, {
    productId: product.id,
    authorId: author.id,
    status,
    title: overrides.title,
    body: overrides.body,
  });
  return { review, productId: product.id, authorId: author.id };
}

function listQueue(token: string, query: Record<string, string> = {}) {
  const qs = new URLSearchParams(query).toString();
  return ctx.request
    .get(`/api/v1/moderation/reviews${qs ? `?${qs}` : ''}`)
    .auth(token, { type: 'bearer' });
}

// Matches fixtures.ts's default password hash for createUser (both hardcode
// 'password123' independently, the same way auth.integration.test.ts's own
// `PASSWORD` constant does) -- not `ctx.loginAs`, deliberately: `loginAs`
// upserts by email and always resets `role` to its own default of
// `CUSTOMER` for any email outside harness.ts's fixed seed map, which would
// silently downgrade a MODERATOR row created here back to CUSTOMER on
// login. Creating the user directly with `role: 'MODERATOR'` and then
// logging in through the raw endpoint (which only reads the row, never
// writes it) is what keeps the role intact.
async function loginAsModerator(email: string): Promise<string> {
  await createUser(ctx.prisma, { email, role: 'MODERATOR' });
  const res = await ctx.request.post('/api/v1/auth/login').send({ email, password: 'password123' });
  if (res.status !== 200) {
    throw new Error(`loginAsModerator(${email}) failed: POST /auth/login returned ${res.status}`);
  }
  return (res.body as { accessToken: string }).accessToken;
}

function decide(reviewId: string, token: string, body: unknown) {
  return ctx.request
    .post(`/api/v1/moderation/reviews/${reviewId}`)
    .auth(token, { type: 'bearer' })
    .send(body as object);
}

describe('GET /api/v1/moderation/reviews', () => {
  // Case 1 (queue half).
  it('rejects a CUSTOMER with 403', async () => {
    const token = await ctx.loginAs('customer1@example.com');
    await listQueue(token).expect(403);
  });

  // Case 2 (queue half).
  it('rejects a request with no token with 401', async () => {
    await ctx.request.get('/api/v1/moderation/reviews').expect(401);
  });

  // Case 3.
  it('shows FLAGGED reviews by default, newest first', async () => {
    const modToken = await ctx.loginAs('mod@example.com');
    const { review: older } = await seedReview('FLAGGED');
    const { review: newer } = await seedReview('FLAGGED', {});
    await ctx.prisma.review.update({ where: { id: older.id }, data: { createdAt: new Date(Date.now() - 60_000) } });
    await seedReview('PENDING');
    await seedReview('APPROVED');

    const res = await listQueue(modToken).expect(200);
    const body = res.body as ModerationQueueBody;
    const ids = body.items.map((r) => r.id);

    expect(ids).toContain(older.id);
    expect(ids).toContain(newer.id);
    expect(ids.indexOf(newer.id)).toBeLessThan(ids.indexOf(older.id));
    expect(body.items.every((r) => r.status === 'FLAGGED')).toBe(true);
  });

  // Case 4.
  it('status=PENDING filters to only PENDING reviews', async () => {
    const modToken = await ctx.loginAs('mod@example.com');
    const { review: pending } = await seedReview('PENDING');
    await seedReview('FLAGGED');

    const res = await listQueue(modToken, { status: 'PENDING' }).expect(200);
    const body = res.body as ModerationQueueBody;

    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.id).toBe(pending.id);
    expect(body.items[0]?.status).toBe('PENDING');
  });

  // Case 9.
  it('includes the full review body and the author display name', async () => {
    const modToken = await ctx.loginAs('mod@example.com');
    const { review } = await seedReview('FLAGGED', {
      title: 'Detailed review title',
      body: 'A long, detailed review body a moderator needs to read in full to judge.',
      authorDisplayName: 'Judgeable Author',
    });

    const res = await listQueue(modToken).expect(200);
    const body = res.body as ModerationQueueBody;
    const item = body.items.find((r) => r.id === review.id);

    expect(item?.title).toBe('Detailed review title');
    expect(item?.body).toBe('A long, detailed review body a moderator needs to read in full to judge.');
    expect(item?.author.displayName).toBe('Judgeable Author');
  });
});

describe('POST /api/v1/moderation/reviews/:id', () => {
  // Case 1 (decision half).
  it('rejects a CUSTOMER with 403', async () => {
    const token = await ctx.loginAs('customer1b@example.com');
    const { review } = await seedReview('FLAGGED');

    await decide(review.id, token, { decision: 'APPROVED', reason: null }).expect(403);
  });

  // Case 2 (decision half).
  it('rejects a request with no token with 401', async () => {
    const { review } = await seedReview('FLAGGED');

    await ctx.request
      .post(`/api/v1/moderation/reviews/${review.id}`)
      .send({ decision: 'APPROVED', reason: null })
      .expect(401);
  });

  // 404 vs 409: a reviewId that never matched any row must not be folded
  // into the same "not awaiting moderation" 409 a real, already-decided
  // review gets — see ReviewsRepository.decide's doc comment for how the
  // follow-up read on the zero-row branch tells the two apart.
  it('returns 404 for a review id that does not exist', async () => {
    const modToken = await loginAsModerator('mod-404@example.com');
    const bogusId = '00000000-0000-4000-8000-000000000000';

    await decide(bogusId, modToken, { decision: 'APPROVED', reason: null }).expect(404);
  });

  // Case 5.
  it('approving a FLAGGED review publishes it and writes one review.approved event', async () => {
    const modToken = await ctx.loginAs('mod@example.com');
    const { review } = await seedReview('FLAGGED');

    const res = await decide(review.id, modToken, { decision: 'APPROVED', reason: null }).expect(200);
    const body = res.body as ReviewDto;

    expect(body.status).toBe('APPROVED');
    expect(body.publishedAt).not.toBeNull();

    const updated = await ctx.prisma.review.findUniqueOrThrow({ where: { id: review.id } });
    expect(updated.status).toBe('APPROVED');
    expect(updated.publishedAt).not.toBeNull();

    const events = await ctx.prisma.outboxEvent.findMany({ where: { aggregateId: review.id } });
    expect(events.map((e) => e.eventType)).toEqual(['review.approved']);
  });

  // Case 6.
  it('rejecting without a reason returns 400', async () => {
    const modToken = await ctx.loginAs('mod@example.com');
    const { review } = await seedReview('FLAGGED');

    await decide(review.id, modToken, { decision: 'REJECTED', reason: null }).expect(400);

    const untouched = await ctx.prisma.review.findUniqueOrThrow({ where: { id: review.id } });
    expect(untouched.status).toBe('FLAGGED');
  });

  // Case 7.
  it('rejecting with a reason stores it and writes one review.rejected event, publishedAt stays null', async () => {
    const modToken = await ctx.loginAs('mod@example.com');
    const { review } = await seedReview('FLAGGED');

    const res = await decide(review.id, modToken, {
      decision: 'REJECTED',
      reason: 'Contains promotional links.',
    }).expect(200);
    const body = res.body as ReviewDto;

    expect(body.status).toBe('REJECTED');
    expect(body.moderationReason).toBe('Contains promotional links.');
    expect(body.publishedAt).toBeNull();

    const updated = await ctx.prisma.review.findUniqueOrThrow({ where: { id: review.id } });
    expect(updated.status).toBe('REJECTED');
    expect(updated.moderationReason).toBe('Contains promotional links.');
    expect(updated.publishedAt).toBeNull();

    const events = await ctx.prisma.outboxEvent.findMany({ where: { aggregateId: review.id } });
    expect(events.map((e) => e.eventType)).toEqual(['review.rejected']);
  });

  // Case 8 (sequential re-decision): a review already decided, decided
  // again by a later, separate request. Real and worth keeping, but on its
  // own this is not proof the guard is a predicated update rather than a
  // read-then-write -- a single request in flight never opens the race
  // window a read-then-write loses, so a read-then-write implementation
  // (read status, check it, then write unconditionally) would pass this
  // exact assertion identically. See the concurrency case directly below
  // for the test that actually distinguishes the two.
  it('approving an already-APPROVED review returns 409 and writes no outbox row', async () => {
    const modToken = await ctx.loginAs('mod@example.com');
    const { review } = await seedReview('APPROVED');

    await decide(review.id, modToken, { decision: 'APPROVED', reason: null }).expect(409);

    const events = await ctx.prisma.outboxEvent.findMany({ where: { aggregateId: review.id } });
    expect(events).toHaveLength(0);
  });

  // Case 8 (concurrency): the property the brief actually calls case 8 "the
  // test for". Two distinct moderators decide the same FLAGGED review at
  // the same moment -- both tokens are resolved before either `decide` call
  // is dispatched (so login round-trips can't stagger the two requests),
  // and there is no `await` and no `.expect()` chained onto either call: an
  // `.expect()` throwing on whichever response loses the race would
  // short-circuit `Promise.all` and the outbox assertion below would never
  // run. Same shape as votes.integration.test.ts's "ten concurrent votes"
  // case.
  //
  // Repeated across five freshly seeded reviews inside this one test,
  // rather than asserted once: a race that passed a single time proves very
  // little about whether it's actually closed.
  it(
    'two moderators approving the same FLAGGED review at once produce exactly one 200, one 409, and one outbox row',
    async () => {
      const [modTokenA, modTokenB] = await Promise.all([
        loginAsModerator('concurrent-mod-a@example.com'),
        loginAsModerator('concurrent-mod-b@example.com'),
      ]);

      for (let attempt = 0; attempt < 5; attempt++) {
        const { review } = await seedReview('FLAGGED');

        const [resA, resB] = await Promise.all([
          decide(review.id, modTokenA, { decision: 'APPROVED', reason: null }),
          decide(review.id, modTokenB, { decision: 'APPROVED', reason: null }),
        ]);

        expect([resA.status, resB.status].sort()).toEqual([200, 409]);

        const events = await ctx.prisma.outboxEvent.findMany({ where: { aggregateId: review.id } });
        expect(events.map((e) => e.eventType)).toEqual(['review.approved']);

        const updated = await ctx.prisma.review.findUniqueOrThrow({ where: { id: review.id } });
        expect(updated.status).toBe('APPROVED');
      }
    },
  );
});
