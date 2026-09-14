import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createProduct, createReview, createUser } from './fixtures.js';
import { setupTestApp } from './harness.js';

// supertest's Response#body is typed `any`; narrow it through this shape
// once instead of sprinkling eslint-disable comments at each access.
interface VoteResponseBody {
  helpfulCount: number;
  notHelpfulCount: number;
}

const ctx = setupTestApp();

interface ApprovedReviewFixture {
  productId: string;
  authorId: string;
  reviewId: string;
}

/** Creates a fresh product, a fresh author, and one APPROVED review by that author. */
async function createApprovedReview(): Promise<ApprovedReviewFixture> {
  const author = await createUser(ctx.prisma);
  const product = await createProduct(ctx.prisma);
  const review = await createReview(ctx.prisma, { productId: product.id, authorId: author.id, status: 'APPROVED' });
  return { productId: product.id, authorId: author.id, reviewId: review.id };
}

function vote(reviewId: string, token: string, value: 'HELPFUL' | 'NOT_HELPFUL') {
  return ctx.request.put(`/api/v1/reviews/${reviewId}/vote`).auth(token, { type: 'bearer' }).send({ value });
}

function unvote(reviewId: string, token: string) {
  return ctx.request.delete(`/api/v1/reviews/${reviewId}/vote`).auth(token, { type: 'bearer' });
}

describe('PUT/DELETE /api/v1/reviews/:reviewId/vote', () => {
  // Case 1.
  it('a first HELPFUL vote sets helpfulCount 1, notHelpfulCount 0', async () => {
    const { reviewId } = await createApprovedReview();
    const voterToken = await ctx.loginAs('voter1@example.com');

    const res = await vote(reviewId, voterToken, 'HELPFUL').expect(200);

    const body = res.body as VoteResponseBody;
    expect(body.helpfulCount).toBe(1);
    expect(body.notHelpfulCount).toBe(0);
  });

  // Case 2. Voting is idempotent, not cumulative.
  it('repeating the identical vote leaves the counts unchanged', async () => {
    const { reviewId } = await createApprovedReview();
    const voterToken = await ctx.loginAs('voter2@example.com');

    await vote(reviewId, voterToken, 'HELPFUL').expect(200);
    const res = await vote(reviewId, voterToken, 'HELPFUL').expect(200);

    const body = res.body as VoteResponseBody;
    expect(body.helpfulCount).toBe(1);
    expect(body.notHelpfulCount).toBe(0);
  });

  // Case 3. Changing a vote moves it rather than stacking.
  it('changing an existing vote to NOT_HELPFUL moves the count instead of stacking', async () => {
    const { reviewId } = await createApprovedReview();
    const voterToken = await ctx.loginAs('voter3@example.com');

    await vote(reviewId, voterToken, 'HELPFUL').expect(200);
    const res = await vote(reviewId, voterToken, 'NOT_HELPFUL').expect(200);

    const body = res.body as VoteResponseBody;
    expect(body.helpfulCount).toBe(0);
    expect(body.notHelpfulCount).toBe(1);
  });

  // Case 4.
  it('DELETE removes the vote and returns the counts to zero', async () => {
    const { reviewId } = await createApprovedReview();
    const voterToken = await ctx.loginAs('voter4@example.com');

    await vote(reviewId, voterToken, 'HELPFUL').expect(200);
    await unvote(reviewId, voterToken).expect(204);

    const review = await ctx.prisma.review.findUniqueOrThrow({ where: { id: reviewId } });
    expect(review.helpfulCount).toBe(0);
    expect(review.notHelpfulCount).toBe(0);
  });

  // Case 5. Removing something already absent has succeeded, not failed.
  it('DELETE with no existing vote returns 204 and does not error', async () => {
    const { reviewId } = await createApprovedReview();
    const voterToken = await ctx.loginAs('voter5@example.com');

    await unvote(reviewId, voterToken).expect(204);
  });

  // Case 6.
  it("rejects the review's author voting on their own review with 403", async () => {
    const author = await createUser(ctx.prisma, { email: 'author6@example.com' });
    const product = await createProduct(ctx.prisma);
    const review = await createReview(ctx.prisma, { productId: product.id, authorId: author.id, status: 'APPROVED' });
    const authorToken = await ctx.loginAs('author6@example.com');

    await vote(review.id, authorToken, 'HELPFUL').expect(403);
  });

  // Case 7. A pending review is not publicly addressable; 403 here would
  // confirm it exists, so this has to be 404 instead.
  it('rejects voting on a review that is not APPROVED with 404', async () => {
    const author = await createUser(ctx.prisma);
    const product = await createProduct(ctx.prisma);
    const review = await createReview(ctx.prisma, { productId: product.id, authorId: author.id, status: 'PENDING' });
    const voterToken = await ctx.loginAs('voter7@example.com');

    await vote(review.id, voterToken, 'HELPFUL').expect(404);
  });

  // Case 8. The point of the task. If counters were maintained with a bare
  // `increment`, this reliably loses updates: two concurrent transactions
  // both read the pre-increment value and each writes back their own +1,
  // so the final count lands below 10. Recomputing the counters from
  // review_votes is what fixes that -- but only because the recompute runs
  // as its own statement *after* a leading `SELECT ... FOR UPDATE` on the
  // review row (see reviews.repository.ts's `lockReviewRow`), never blocked
  // itself. A statement's READ COMMITTED snapshot is taken at that
  // statement's start, not at the moment a lock it's waiting on is granted
  // -- a statement that blocks and then unblocks does NOT get a fresh view
  // of other tables it reads, only of the specific row it collided on. So
  // merging the lock into the same `UPDATE ... FROM review_votes`
  // statement (rather than acquiring it first, separately) reproduces the
  // exact bug this test exists to catch: it was tried, and ten concurrent
  // voters landed on `helpfulCount: 1`, not 10.
  //
  // The ten requests are launched with Promise.all over an array of
  // already-started request promises (no `await` between the ten `vote()`
  // calls below), so all ten reach the server and begin their transactions
  // before any of them resolves — a sequential loop of `await vote(...)`
  // would never exercise the race this test exists to catch.
  it('ten concurrent votes from ten distinct users produce helpfulCount 10', async () => {
    const { reviewId } = await createApprovedReview();
    const voters = await Promise.all(
      Array.from({ length: 10 }, (_, i) => ctx.loginAs(`concurrent-voter-${i}@example.com`)),
    );

    const responses = await Promise.all(voters.map((token) => vote(reviewId, token, 'HELPFUL')));

    for (const res of responses) {
      expect(res.status).toBe(200);
    }

    const review = await ctx.prisma.review.findUniqueOrThrow({ where: { id: reviewId } });
    expect(review.helpfulCount).toBe(10);
    expect(review.notHelpfulCount).toBe(0);

    const voteRows = await ctx.prisma.reviewVote.count({ where: { reviewId } });
    expect(voteRows).toBe(10);
  });

  // Case 9.
  it('rejects an unauthenticated vote and unvote with 401', async () => {
    const { reviewId } = await createApprovedReview();

    await ctx.request.put(`/api/v1/reviews/${reviewId}/vote`).send({ value: 'HELPFUL' }).expect(401);
    await ctx.request.delete(`/api/v1/reviews/${reviewId}/vote`).expect(401);
  });

  it('rejects an invalid vote value with 400', async () => {
    const { reviewId } = await createApprovedReview();
    const voterToken = await ctx.loginAs('voter-invalid@example.com');

    await ctx.request
      .put(`/api/v1/reviews/${reviewId}/vote`)
      .auth(voterToken, { type: 'bearer' })
      .send({ value: 'LOVE_IT' })
      .expect(400);
  });

  it('returns 404 when voting on a review that does not exist', async () => {
    const voterToken = await ctx.loginAs('voter-missing@example.com');

    await vote(randomUUID(), voterToken, 'HELPFUL').expect(404);
  });

  // A malformed reviewId reaches ReviewsRepository's raw `::uuid` cast
  // (lockReviewRow/recomputeVoteCounts in reviews.repository.ts) unless
  // ParseUUIDPipe rejects it first. Without the pipe this 500s: Postgres
  // raises 22P02 for the bad cast, and the global PrismaExceptionFilter
  // only maps P2002/P2025, so anything else falls through to 500.
  it('rejects a syntactically invalid reviewId with 400, not 500', async () => {
    const voterToken = await ctx.loginAs('voter-malformed@example.com');

    await ctx.request
      .put('/api/v1/reviews/not-a-uuid/vote')
      .auth(voterToken, { type: 'bearer' })
      .send({ value: 'HELPFUL' })
      .expect(400);
    await ctx.request.delete('/api/v1/reviews/not-a-uuid/vote').auth(voterToken, { type: 'bearer' }).expect(400);
  });
});
