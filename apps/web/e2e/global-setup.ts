/**
 * Runs once before the whole suite. Its only job is making the suite
 * repeatable against the shared dev stack without touching anything that
 * doesn't belong to it.
 *
 * `review-lifecycle.spec.ts` signs in as the seeded `alice@example.com`
 * and submits a fresh review for the seeded `smart-led-desk-lamp` product
 * on every run. Two pieces of state stop a second run from doing that
 * cleanly, and neither can be fixed by resetting the database — this
 * suite runs against a shared dev Postgres other work may depend on, and
 * re-seeding it is explicitly out of bounds. The API also has no route
 * to create a throwaway user or product for this suite to own outright
 * (`AuthController` only logs in against existing accounts;
 * `ProductsController` has no create route), so "give the spec its own
 * users and products" isn't reachable with the API surface this system
 * actually exposes today. Both cleanups below are therefore scoped as
 * narrowly as the shared stack allows: touch exactly the state this
 * spec's own author leaves behind, nothing anyone else put there.
 *
 * 1. The API allows exactly one review per (author, product) pair
 *    (`packages/db/prisma/schema.prisma`'s `productId_authorId` unique
 *    constraint), so a review alice's account left behind by a previous
 *    run would make the very next run fail on a 409 the moment it tries
 *    to submit. `DELETE /reviews/:id`, open to a review's own author, is
 *    what's available instead — logging in as alice and deleting
 *    whatever review she already has for that one product, through the
 *    same route a real user would use to delete their own review.
 *
 * 2. `ReviewsController#submit` is rate-limited to
 *    `REVIEW_SUBMIT_RATE_LIMIT` submissions per hour per user
 *    (`apps/api/src/common/throttle/throttle.module.ts`), counted in
 *    Redis and keyed by user id — a few runs of this spec in the same
 *    hour exhausts alice's quota, and unlike the review row above there
 *    is no DELETE route for a rate-limit counter. The two Redis keys it
 *    lives under are fully determined by the same key derivation
 *    `ThrottlerGuard` itself uses (see below), so they can be computed
 *    and cleared directly — the narrowest fix available, equivalent to
 *    what restarting only the throttler's own Redis database would do,
 *    without touching the cache entries or outbox state any other
 *    component keeps in that same Redis instance.
 *
 * `browse.spec.ts` performs no writes at all, so it needs neither
 * cleanup.
 */
import { createHash } from 'node:crypto';
import { createConnection } from 'node:net';
import { request } from '@playwright/test';

const CLEANUP_EMAIL = 'alice@example.com';
const CLEANUP_PASSWORD = 'password123';
const CLEANUP_PRODUCT_SLUG = 'smart-led-desk-lamp';

interface LoginResponse {
  accessToken: string;
  user: { id: string };
}

interface ProductResponse {
  id: string;
}

interface ReviewListResponse {
  items: Array<{ id: string }>;
}

/**
 * Deletes every review alice currently has for the seeded desk lamp
 * product, so `review-lifecycle.spec.ts` can submit a fresh one without
 * hitting the one-review-per-(author,product) unique constraint. Returns
 * alice's own user id — `resetSubmitThrottle` below needs it too, and
 * this is the one call in this file that already produces it.
 */
async function deleteAlicesExistingReview(): Promise<string> {
  // A trailing slash on baseURL plus no leading slash on every path below
  // is deliberate, not cosmetic: `APIRequestContext` resolves a relative
  // URL the same way `new URL(path, base)` does, and a *leading*-slash
  // path there discards the whole of `base`'s own path (`/api/v1`),
  // resolving against the bare origin instead — a real bug this file hit
  // during development (every call 404ing against `/auth/login` instead
  // of `/api/v1/auth/login`).
  const apiURL = process.env.E2E_API_URL ?? 'http://localhost:3001/api/v1/';
  const context = await request.newContext({ baseURL: apiURL });

  try {
    const loginResponse = await context.post('auth/login', {
      data: { email: CLEANUP_EMAIL, password: CLEANUP_PASSWORD },
    });
    if (!loginResponse.ok()) {
      throw new Error(
        `global setup: could not sign in as ${CLEANUP_EMAIL} to clean up (status ${loginResponse.status()}). ` +
          'Is the API running and seeded?',
      );
    }
    const { accessToken, user } = (await loginResponse.json()) as LoginResponse;
    const authHeader = { Authorization: `Bearer ${accessToken}` };

    const productResponse = await context.get(`products/${CLEANUP_PRODUCT_SLUG}`);
    if (!productResponse.ok()) {
      throw new Error(
        `global setup: seeded product "${CLEANUP_PRODUCT_SLUG}" was not found (status ${productResponse.status()}). ` +
          'Is the dev database seeded?',
      );
    }
    const product = (await productResponse.json()) as ProductResponse;

    const mineResponse = await context.get('me/reviews', {
      headers: authHeader,
      params: { productId: product.id },
    });
    if (!mineResponse.ok()) {
      throw new Error(`global setup: could not list alice's reviews (status ${mineResponse.status()}).`);
    }
    const mine = (await mineResponse.json()) as ReviewListResponse;

    for (const review of mine.items) {
      const deleteResponse = await context.delete(`reviews/${review.id}`, { headers: authHeader });
      if (!deleteResponse.ok() && deleteResponse.status() !== 404) {
        throw new Error(
          `global setup: could not delete alice's leftover review ${review.id} (status ${deleteResponse.status()}).`,
        );
      }
    }

    return user.id;
  } finally {
    await context.dispose();
  }
}

/** One RESP-encoded Redis request: `*<argc>\r\n($<len>\r\n<arg>\r\n)+`. */
function encodeRespCommand(args: readonly string[]): string {
  let encoded = `*${args.length}\r\n`;
  for (const arg of args) {
    encoded += `$${Buffer.byteLength(arg)}\r\n${arg}\r\n`;
  }
  return encoded;
}

/**
 * Sends one or more commands over a fresh connection and resolves once a
 * simple reply (`+OK`, `:N`, `-ERR ...`) has come back for each — every
 * reply this file ever expects here is one of those single-line forms,
 * so counting `\r\n` terminators is enough without pulling in a full RESP
 * parser (or a Redis client dependency) for two DEL calls. No dependency
 * beyond Node's own `net` is added to `apps/web` purely for this.
 */
async function sendRedisCommands(redisUrl: string, commands: ReadonlyArray<readonly string[]>): Promise<void> {
  const url = new URL(redisUrl);
  const host = url.hostname;
  const port = Number(url.port || 6379);
  const password = url.password || undefined;

  const allCommands = password ? [['AUTH', password], ...commands] : commands;

  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host, port });
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error(`timed out talking to Redis at ${host}:${port}`));
    }, 5_000);

    socket.on('connect', () => {
      socket.write(allCommands.map(encodeRespCommand).join(''));
    });

    let received = '';
    socket.on('data', (chunk: Buffer) => {
      received += chunk.toString('utf8');
      const repliesSeen = (received.match(/\r\n/g) ?? []).length;
      if (repliesSeen >= allCommands.length) {
        clearTimeout(timeout);
        socket.end();
      }
    });
    socket.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    socket.on('close', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

/**
 * Clears alice's `ReviewSubmitThrottlerGuard` counter so a run that
 * follows soon after another one isn't rejected with 429 before it ever
 * reaches the moderation logic this spec exists to exercise.
 *
 * The two Redis keys are derived exactly the way `@nestjs/throttler`'s
 * `ThrottlerGuard.generateKey` and `ThrottlerStorageRedisService.increment`
 * derive them (see those two, respectively, for the source this mirrors):
 * `sha256("<ControllerName>-<handlerName>-<throttlerName>-<tracker>")`
 * for the key, then `{<key>:<throttlerName>}:hits` /
 * `{<key>:<throttlerName>}:blocked` for the two records that key's
 * counter and block flag actually live under. `ReviewsController`'s
 * handler is named `submit`; the throttler config in throttle.module.ts
 * registers no explicit name, which `ThrottlerGuard.onModuleInit`
 * defaults to `'default'`; and `ReviewSubmitThrottlerGuard.getTracker`
 * uses the authenticated user's id as the tracker.
 */
async function resetSubmitThrottle(aliceUserId: string): Promise<void> {
  const redisUrl = process.env.E2E_REDIS_URL ?? process.env.REDIS_URL ?? 'redis://localhost:6379';
  const throttlerKey = createHash('sha256').update(`ReviewsController-submit-default-${aliceUserId}`).digest('hex');
  const hitsKey = `{${throttlerKey}:default}:hits`;
  const blockedKey = `{${throttlerKey}:default}:blocked`;

  await sendRedisCommands(redisUrl, [['DEL', hitsKey, blockedKey]]);
}

async function globalSetup(): Promise<void> {
  const aliceUserId = await deleteAlicesExistingReview();

  try {
    await resetSubmitThrottle(aliceUserId);
  } catch (error) {
    // Not fatal: at worst, a run soon after another one hits 429 instead
    // of the flagged/approved flow it expects, which fails loudly and
    // legibly rather than in a way this suite could silently mask.
    console.warn(
      `global setup: could not reset alice's review-submission rate limit (${
        error instanceof Error ? error.message : String(error)
      }). If the next run gets a 429, this is why.`,
    );
  }
}

export default globalSetup;
