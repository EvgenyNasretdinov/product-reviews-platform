# Plan 3 — Web Application and Delivery

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A working storefront over the reviews API — catalogue, product page with ratings and reviews, submission, voting, and a moderation queue — plus everything a new developer needs to run, understand, and extend the project: one-command Compose, CI, a README, and ADRs.

**Architecture:** Next.js App Router. Server Components read through the API on the server so the catalogue and product pages render without a client round-trip; mutations go through React Query against the same API from the browser. The JWT never reaches client JavaScript: a Next Route Handler performs the login and stores the token in an httpOnly cookie, and server-side fetches attach it from there.

**Tech Stack:** Next.js 15 (App Router), React 19, Tailwind CSS 4, shadcn/ui, TanStack Query 5, Zod (shared contracts), Playwright, Vitest + Testing Library, Docker, GitHub Actions.

**Spec:** `docs/design/2026-09-13-product-reviews-design.md`

**Depends on:** Plans 1 and 2 complete.

## Global Constraints

All of Plan 1's Global Constraints apply unchanged. Additionally:

- The frontend never talks to Postgres, Redis, or RabbitMQ. Its only dependency is the HTTP API.
- Request and response types come from `@reviews/contracts`. The web app defines no parallel type for anything the API already describes.
- No secret is exposed to the browser. Only `NEXT_PUBLIC_*` variables reach client code, and the JWT is not among them.
- Every interactive element is reachable and operable by keyboard, and every rating is announced to assistive technology as text, not as a row of glyphs.
- The UI must make moderation state legible. A user who submits a review and sees nothing happen will assume the site is broken.

---

### Task 1: Web app skeleton, API client, and session handling

**Files:**
- Create: `apps/web/package.json`, `tsconfig.json`, `next.config.ts`, `postcss.config.mjs`, `vitest.config.ts`, `.env.example`
- Create: `apps/web/app/layout.tsx`, `app/globals.css`, `app/providers.tsx`
- Create: `apps/web/lib/api-client.ts`, `lib/session.ts`, `lib/errors.ts`
- Create: `apps/web/app/api/session/route.ts` (POST login, DELETE logout)
- Create: `apps/web/app/login/page.tsx`, `components/login-form.tsx`
- Test: `apps/web/lib/api-client.test.ts`, `apps/web/lib/session.test.ts`

**Interfaces:**
- Produces:
  - `apiFetch<T>(path: string, init?: RequestInit & { schema?: ZodType<T>; token?: string }): Promise<T>` from `lib/api-client.ts` — prefixes `API_BASE_URL`, sets JSON headers, attaches a bearer token when given, parses the response with the supplied schema, and throws a typed `ApiError { status, message, code? }` for any non-2xx.
  - `getServerSession(): Promise<SessionUser | null>` and `getServerToken(): Promise<string | null>` from `lib/session.ts`, both reading the `session` cookie via `next/headers`.
  - `POST /api/session` — proxies login to the API and sets the cookie `httpOnly`, `sameSite: 'lax'`, `secure` in production, `maxAge` matching the token. `DELETE /api/session` clears it.
  - Two environment variables, distinguished deliberately: `API_INTERNAL_URL` (server-side, `http://api:3001/api/v1` under Compose) and `NEXT_PUBLIC_API_URL` (browser-side, `http://localhost:3001/api/v1`). Conflating them is the classic Compose failure — the browser cannot resolve the service name `api`, and the server should not route through the host.

- [ ] **Step 1: Write the failing tests**

`apps/web/lib/api-client.test.ts`, using `vi.stubGlobal('fetch', ...)`:

```ts
it('parses a successful response with the supplied schema', async () => {
  stubFetch(200, { id: '1', name: 'Lamp' });
  const result = await apiFetch('/products/lamp', { schema: z.object({ id: z.string(), name: z.string() }) });
  expect(result).toEqual({ id: '1', name: 'Lamp' });
});

it('throws ApiError carrying the status and the server message', async () => {
  stubFetch(409, { message: 'you have already reviewed this product', reviewId: 'r1' });
  await expect(apiFetch('/products/p/reviews', { method: 'POST' })).rejects.toMatchObject({
    status: 409,
    message: 'you have already reviewed this product',
  });
});

it('throws ApiError rather than a ZodError when the body does not match the schema', async () => {
  stubFetch(200, { unexpected: true });
  await expect(apiFetch('/products/lamp', { schema: z.object({ id: z.string() }) })).rejects.toBeInstanceOf(ApiError);
});

it('attaches a bearer token when one is supplied and omits the header otherwise', async () => { /* inspect the fetch init */ });

it('uses the internal base URL on the server and the public one in the browser', async () => { /* toggle a window stub */ });
```

The third case matters: a schema mismatch surfacing as a raw `ZodError` inside a React Server Component produces an opaque 500 rather than a handled error state.

`apps/web/lib/session.test.ts`: a missing cookie yields `null`; a malformed cookie yields `null` rather than throwing; a valid cookie yields the parsed user.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @reviews/web test:unit`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

Scaffold the Next app with Tailwind and shadcn/ui, `app/globals.css` defining CSS variables for light and dark so the design does not hardcode colours at call sites.

`lib/api-client.ts` selects the base URL with `typeof window === 'undefined' ? process.env.API_INTERNAL_URL : process.env.NEXT_PUBLIC_API_URL`, and wraps schema-parse failures in `ApiError` with status `502` and a message naming the endpoint.

`app/api/session/route.ts` posts to `/auth/login`, and on success writes `cookies().set('session', JSON.stringify({ token, user }), { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/', maxAge })`.

`app/login/page.tsx` renders the form plus a short list of seeded accounts as one-click buttons, each labelled with its role. This is a demo convenience and the page says so in plain text, so nobody mistakes it for a login pattern.

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter @reviews/web test:unit && pnpm --filter @reviews/web build`
Expected: PASS and a successful production build.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(web): add app shell, typed API client, and cookie-backed sessions

The access token is held in an httpOnly cookie set by a route handler
rather than in localStorage, so client JavaScript cannot read it and an
XSS bug cannot exfiltrate a session.

Server-side and browser-side base URLs are separate variables on
purpose: under Compose the server reaches the API by service name while
the browser must use the published host port, and collapsing the two
produces a site that works in development and fails in a container.

Responses are parsed with the shared contract schemas, and a mismatch
raises the same typed ApiError as an HTTP failure so pages have one
error path instead of two."
```

---

### Task 2: Product catalogue

**Files:**
- Create: `apps/web/app/page.tsx`, `components/product-card.tsx`, `components/rating-stars.tsx`, `components/search-field.tsx`, `components/empty-state.tsx`
- Test: `apps/web/components/rating-stars.test.tsx`

**Interfaces:**
- Produces: `<RatingStars value={number} count={number | undefined} size="sm" | "md" | "lg" />` rendering five stars with partial fill, plus an accessible text label. Reused on the catalogue, the product header, and every review.

- [ ] **Step 1: Write the failing component test**

```ts
import { render, screen } from '@testing-library/react';
import { RatingStars } from './rating-stars.js';

it('announces the rating as text for assistive technology', () => {
  render(<RatingStars value={3.75} count={12} />);
  expect(screen.getByRole('img', { name: '3.75 out of 5 stars, 12 reviews' })).toBeInTheDocument();
});

it('renders a zero rating without reviews as unrated', () => {
  render(<RatingStars value={0} count={0} />);
  expect(screen.getByRole('img', { name: 'No reviews yet' })).toBeInTheDocument();
});

it('clamps out-of-range values instead of overflowing the row', () => {
  render(<RatingStars value={7} count={1} />);
  expect(screen.getByRole('img', { name: /5 out of 5/ })).toBeInTheDocument();
});
```

A row of star glyphs with no text label is unreadable to a screen reader, and "no reviews" rendered as zero stars reads as a one-star product to everyone.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @reviews/web test:unit -- rating-stars`
Expected: FAIL.

- [ ] **Step 3: Implement**

`app/page.tsx` is a Server Component reading `searchParams.q`, calling `apiFetch('/products?...')`, and rendering a responsive grid. Search submits through a plain form navigation so it works without JavaScript and keeps the query in the URL, which makes results shareable and the back button correct.

Include the states that are usually skipped and always occur: an empty catalogue, no search results (with the query echoed and a reset link), and a product with no reviews.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @reviews/web test:unit -- rating-stars`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(web): add the product catalogue with search

Renders on the server so the catalogue arrives as HTML rather than as a
spinner that fetches, which is what a storefront needs for both
perceived speed and indexing.

Search is a form navigation rather than client state, so results are
shareable by URL, the back button behaves, and the page works before
JavaScript loads.

The star component exposes the rating as a text label. Five glyphs with
no accessible name are silence to a screen reader, and an unrated
product must read as unrated rather than as one star."
```

---

### Task 3: Product page with rating breakdown and review list

**Files:**
- Create: `apps/web/app/products/[slug]/page.tsx`, `components/rating-summary.tsx`, `components/review-list.tsx`, `components/review-item.tsx`, `components/review-sort-select.tsx`
- Create: `apps/web/hooks/use-reviews.ts`
- Test: `apps/web/components/rating-summary.test.tsx`

**Interfaces:**
- Produces: `useReviews(productId, { sort, rating })` — a TanStack `useInfiniteQuery` keyed on `['reviews', productId, sort, rating]`, paging with `nextCursor`.

- [ ] **Step 1: Write the failing component test**

```ts
it('renders each star row as a percentage of the total', () => {
  render(<RatingSummary summary={{ reviewCount: 4, averageRating: 3.75, distribution: { 1: 1, 2: 0, 3: 0, 4: 1, 5: 2 } }} onFilter={vi.fn()} activeFilter={null} />);
  expect(screen.getByRole('button', { name: '5 stars, 2 reviews, 50%' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '2 stars, 0 reviews, 0%' })).toBeInTheDocument();
});

it('calls onFilter with the star value when a row is activated', async () => {
  const onFilter = vi.fn();
  render(<RatingSummary summary={fourReviews} onFilter={onFilter} activeFilter={null} />);
  await userEvent.click(screen.getByRole('button', { name: /5 stars/ }));
  expect(onFilter).toHaveBeenCalledWith(5);
});

it('clears the filter when the active row is activated again', async () => { /* onFilter called with null */ });

it('divides by zero safely when a product has no reviews', () => {
  render(<RatingSummary summary={{ reviewCount: 0, averageRating: 0, distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } }} onFilter={vi.fn()} activeFilter={null} />);
  expect(screen.getByText(/no reviews yet/i)).toBeInTheDocument();
  expect(screen.queryByText('NaN%')).not.toBeInTheDocument();
});
```

`NaN%` from `0/0` is the defect this component ships with if nobody writes that last test.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @reviews/web test:unit -- rating-summary`
Expected: FAIL.

- [ ] **Step 3: Implement**

The page is a Server Component fetching the product detail; the review list below it is a Client Component using `useReviews`, so sorting and filtering do not re-render the product header or lose scroll position.

Histogram rows are `<button>` elements, not decorated divs, so they are focusable and operable by keyboard for free. Selecting a row sets `?rating=5` in the URL via `router.replace` with `scroll: false`, keeping filter state shareable without jumping the page.

Handle each list state explicitly: loading skeletons on first load, an inline spinner on "load more", an empty state distinguishing "no reviews yet" from "no reviews with this filter" (the latter offering to clear the filter), and an error state with a retry button.

Every review shows the author's display name, the date, the star rating, a "Verified purchase" badge where applicable, and the vote control from Task 5.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @reviews/web test:unit -- rating-summary`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(web): add the product page with rating breakdown and review list

The star histogram doubles as the filter control, which is how shoppers
actually use it: the interesting question is usually what the one-star
reviews say. Rows are real buttons, so keyboard and screen-reader
support come from the element rather than from added attributes.

Sort and filter live in the URL, so a filtered view is shareable and
the back button steps through it.

The list distinguishes 'no reviews yet' from 'no reviews match this
filter' and offers to clear the filter in the second case. Collapsing
the two states into one empty message is how a filter turns into a
dead end."
```

---

### Task 4: Review submission and the author's own review

**Files:**
- Create: `apps/web/components/review-form.tsx`, `components/your-review.tsx`, `components/status-badge.tsx`
- Create: `apps/web/hooks/use-submit-review.ts`
- Test: `apps/web/components/review-form.test.tsx`, `apps/web/components/status-badge.test.tsx`

**Interfaces:**
- Produces: `useSubmitReview(productId)` — a mutation that invalidates `['reviews', productId]` and `['me', 'reviews']` on success and surfaces `409` as a field-level message rather than a generic failure.

- [ ] **Step 1: Write the failing component tests**

```ts
it('disables submission until the form is valid', async () => {
  render(<ReviewForm productId="p1" onSubmit={vi.fn()} />);
  expect(screen.getByRole('button', { name: /submit/i })).toBeDisabled();
  await userEvent.click(screen.getByRole('radio', { name: '4 stars' }));
  await userEvent.type(screen.getByLabelText(/title/i), 'Good lamp');
  await userEvent.type(screen.getByLabelText(/review/i), 'It has worked well for two months.');
  expect(screen.getByRole('button', { name: /submit/i })).toBeEnabled();
});

it('shows the same validation messages the API enforces', async () => {
  // type a 5-character body, blur, expect "at least 10 characters"
  // the shared Zod schema is the source, so the client cannot drift from the server
});

it('explains a 409 in place rather than as a generic error', async () => {
  const onSubmit = vi.fn().mockRejectedValue(new ApiError(409, 'you have already reviewed this product'));
  render(<ReviewForm productId="p1" onSubmit={onSubmit} />);
  await fillValidForm();
  await userEvent.click(screen.getByRole('button', { name: /submit/i }));
  expect(await screen.findByText(/already reviewed/i)).toBeInTheDocument();
});

it('keeps the entered text when submission fails', async () => {
  // a failed submit must not clear the textarea — losing a paragraph of typing to a network blip is unforgivable
});
```

`status-badge.test.tsx`: `PENDING` renders "Awaiting moderation" with a neutral tone; `REJECTED` renders the moderation reason; `APPROVED` renders nothing, since a published review needs no badge.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @reviews/web test:unit -- review-form`
Expected: FAIL.

- [ ] **Step 3: Implement**

The form validates with `createReviewInputSchema` from `@reviews/contracts` through `@hookform/resolvers/zod`, so client-side messages come from the same schema the API enforces.

On success the page shows the author's review above the public list in a "Your review" panel with the pending badge and a line of copy explaining that reviews are checked before publication. This is the piece that turns an invisible asynchronous delay into understood product behaviour — without it the review vanishes and the user resubmits.

Rating input is a radio group, not a row of clickable spans, so arrow keys work and the current value is announced.

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter @reviews/web test:unit -- 'review-form|status-badge'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(web): add review submission with visible moderation state

A submitted review does not appear in the public list until it is
approved, so the product page shows the author their own review in a
panel with an 'awaiting moderation' badge and a line explaining why.
Without that panel the review simply disappears, the user concludes the
site is broken, and resubmits.

Validation runs against the same Zod schema the API enforces, so the
two cannot drift and the user is never rejected by the server for
something the form accepted.

A failed submission keeps the typed text. Losing a written paragraph to
a network error is the kind of detail that decides whether anyone
writes a second review."
```

---

### Task 5: Helpfulness voting

**Files:**
- Create: `apps/web/components/vote-buttons.tsx`, `hooks/use-vote.ts`
- Test: `apps/web/components/vote-buttons.test.tsx`

**Interfaces:**
- Produces: `useVote(reviewId, productId)` — optimistic mutation updating the cached review counts and rolling back on error.

- [ ] **Step 1: Write the failing component test**

Cases: the counts render; clicking "Helpful" increments optimistically before the promise settles; clicking the active vote again clears it; a rejected mutation restores the original counts and shows a message; the author's own review renders the counts without buttons; a signed-out visitor sees the counts and a prompt to sign in rather than a button that fails.

```ts
it('rolls the count back when the request fails', async () => {
  const vote = vi.fn().mockRejectedValue(new ApiError(500, 'boom'));
  render(<VoteButtons reviewId="r1" helpfulCount={4} notHelpfulCount={0} onVote={vote} canVote />);
  await userEvent.click(screen.getByRole('button', { name: /helpful/i }));
  expect(await screen.findByText('4')).toBeInTheDocument();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @reviews/web test:unit -- vote-buttons`
Expected: FAIL.

- [ ] **Step 3: Implement**

`useVote` uses TanStack Query's `onMutate`/`onError`/`onSettled` triple: cancel in-flight queries, snapshot the cached page, apply the delta, restore on failure, and invalidate on settle. Optimism is right here because the action is trivially reversible and the latency is otherwise visible on every click.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @reviews/web test:unit -- vote-buttons`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(web): add optimistic helpfulness voting

The count updates on click and rolls back if the request fails. A vote
is cheap and reversible, which is exactly the case where waiting for a
round-trip before showing the result feels broken.

Signed-out visitors see the counts and an invitation to sign in rather
than a button that fails on click, and authors see their own counts
without controls, matching the server rule that they cannot vote on
themselves."
```

---

### Task 6: Moderation queue

**Files:**
- Create: `apps/web/app/moderation/page.tsx`, `components/moderation-queue.tsx`, `components/moderation-decision-dialog.tsx`
- Create: `apps/web/hooks/use-moderation.ts`
- Test: `apps/web/components/moderation-queue.test.tsx`

**Interfaces:**
- Produces: a `MODERATOR`-only page listing flagged and pending reviews with approve and reject actions.

- [ ] **Step 1: Write the failing component test**

Cases: the queue renders each review's full body, product name, author, rating, and the reason it was flagged; "Approve" calls the mutation with `APPROVED`; "Reject" opens a dialog that requires a reason and keeps the confirm button disabled while it is empty; a decided item leaves the list; an empty queue shows a clear "nothing to review" state rather than a blank page.

The reject dialog must use a form and a focus trap from the shadcn `Dialog`, not `window.confirm`.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @reviews/web test:unit -- moderation-queue`
Expected: FAIL.

- [ ] **Step 3: Implement**

`app/moderation/page.tsx` reads the session server-side and redirects a non-moderator to `/` before rendering anything — the API enforces the rule regardless, but a UI that renders a moderator page and then 403s on every action is a bug, not defence in depth.

Show the automatic policy's reason next to each flagged review so the moderator knows what triggered it.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @reviews/web test:unit -- moderation-queue`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(web): add the moderator queue

Shows each flagged review in full, together with the reason the
automatic policy flagged it, since a moderator cannot judge an excerpt
and should not have to guess what tripped the filter.

Rejection requires a reason before the confirm button enables. The
reason is what the author sees in their own review list, and a
rejection without one is indistinguishable from the review having
vanished.

The page redirects a non-moderator server-side rather than relying on
the API's 403. The API check is the real control; rendering a page
whose every button fails is simply a broken screen."
```

---

### Task 7: End-to-end tests

**Files:**
- Create: `apps/web/playwright.config.ts`, `apps/web/e2e/browse.spec.ts`, `e2e/review-lifecycle.spec.ts`, `e2e/fixtures.ts`
- Modify: root `package.json` (`test:e2e` script)

**Interfaces:**
- Produces: `pnpm test:e2e` running Playwright against a Compose stack seeded with known data.

- [ ] **Step 1: Write the failing E2E specs**

`e2e/browse.spec.ts` — a guest journey:

```ts
test('a guest can browse the catalogue and read reviews', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /products/i })).toBeVisible();

  await page.getByRole('link', { name: /desk lamp/i }).click();
  await expect(page.getByRole('img', { name: /out of 5 stars/ })).toBeVisible();

  await page.getByRole('button', { name: /5 stars/ }).click();
  await expect(page).toHaveURL(/rating=5/);
  for (const stars of await page.getByTestId('review-rating').all()) {
    await expect(stars).toHaveAttribute('aria-label', /5 out of 5/);
  }

  await page.getByRole('combobox', { name: /sort/i }).selectOption('newest');
  await expect(page.getByTestId('review-item').first()).toBeVisible();
});
```

`e2e/review-lifecycle.spec.ts` — the full asynchronous loop, which is the flow no unit test can cover:

```ts
test('a submitted review is moderated and becomes publicly visible', async ({ page, browser }) => {
  await signIn(page, 'alice@example.com');
  await page.goto('/products/smart-led-desk-lamp');

  await page.getByRole('radio', { name: '2 stars' }).click();
  await page.getByLabel(/title/i).fill('Stopped working');
  await page.getByLabel(/review/i).fill('IT BROKE AFTER A WEEK AND SUPPORT NEVER REPLIED');
  await page.getByRole('button', { name: /submit/i }).click();

  // shouting from a non-verified purchaser is flagged, not auto-approved
  await expect(page.getByTestId('your-review')).toContainText(/awaiting moderation/i);
  await expect(page.getByTestId('review-list')).not.toContainText('Stopped working');

  const moderator = await signInAs(browser, 'mod@example.com');
  await moderator.goto('/moderation');
  await expect(moderator.getByText('Stopped working')).toBeVisible();
  await moderator.getByRole('button', { name: /approve/i }).first().click();

  await page.reload();
  await expect(page.getByTestId('review-list')).toContainText('Stopped working');
  await expect(page.getByTestId('rating-summary')).toContainText('reviews');
});
```

The assertion that the review is *absent* from the public list before approval is as important as the one that it appears after: it is the only check that the moderation gate is actually closed.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm test:e2e`
Expected: FAIL — no Compose stack or no matching selectors.

- [ ] **Step 3: Implement**

`playwright.config.ts` sets `baseURL` from `E2E_BASE_URL` (default `http://localhost:3000`), `retries: process.env.CI ? 2 : 0`, `trace: 'on-first-retry'`, and a `webServer` block only for local runs; in CI the stack is started by the workflow.

Add stable `data-testid` attributes for the containers the specs address — `review-list`, `review-item`, `review-rating`, `your-review`, `rating-summary` — rather than binding assertions to CSS classes, which change with every styling pass.

Add a Playwright global setup that resets the database to the seed before the run, so the suite is repeatable.

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm compose:up && pnpm test:e2e`
Expected: PASS, both specs.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "test(e2e): cover browsing and the full review lifecycle

The lifecycle spec is the only test that exercises the whole system as
a user meets it: submit, get held for moderation, get approved by
another account in another browser context, then appear publicly with
the rating updated.

It asserts that the review is absent from the public list before
approval as well as present after. Only the first assertion proves the
moderation gate is actually closed; without it the test would pass on a
system that published everything immediately.

Selectors are data-testid attributes rather than classes, so a styling
change does not break the suite and a broken test means broken
behaviour."
```

---

### Task 8: Containerisation and one-command startup

**Files:**
- Create: `apps/api/Dockerfile`, `apps/worker/Dockerfile`, `apps/web/Dockerfile`, `.dockerignore`
- Create: `docker-compose.yml`
- Create: `scripts/smoke.sh`
- Modify: root `package.json` (`compose:up`, `compose:down`, `smoke`)

**Interfaces:**
- Produces: `docker compose up` bringing up Postgres, Redis, RabbitMQ, the API, the worker, and the web app, with migrations and seed applied automatically, reachable at `http://localhost:3000`.

- [ ] **Step 1: Write the failing smoke test**

`scripts/smoke.sh` checks the assembled system rather than its parts:

```bash
#!/usr/bin/env bash
set -euo pipefail
API=${API_URL:-http://localhost:3001/api/v1}
WEB=${WEB_URL:-http://localhost:3000}

curl -fsS "$API/health/ready" | grep -q '"database":"up"'    || { echo "FAIL: api not ready"; exit 1; }
test "$(curl -fsS "$API/products" | jq '.items | length')" -gt 0 || { echo "FAIL: catalogue is empty, seed did not run"; exit 1; }
curl -fsS "$WEB" | grep -qi '<title'                          || { echo "FAIL: web did not render"; exit 1; }
curl -fsS "$API/docs-json" | jq -e '.paths' >/dev/null        || { echo "FAIL: openapi document missing"; exit 1; }
echo "OK: api, worker seed, web, and docs all responding"
```

The catalogue-not-empty check is the one that catches the most common Compose failure — the stack starts, every container is healthy, and nothing works because migrations or seed never ran.

- [ ] **Step 2: Run to verify it fails**

Run: `./scripts/smoke.sh`
Expected: FAIL — nothing is listening.

- [ ] **Step 3: Write the Dockerfiles**

Each is multi-stage on `node:22-alpine`: a `deps` stage installing with `pnpm install --frozen-lockfile`, a `build` stage running `turbo run build --filter=<app>...`, and a slim runtime stage copying only the built output and production dependencies, running as the non-root `node` user with `NODE_ENV=production`.

For `apps/api` and `apps/worker` the runtime stage must include the generated Prisma client and the query engine; run `prisma generate` in the build stage and copy `node_modules/.prisma`.

`apps/web` uses Next's `output: 'standalone'` so the runtime image carries a minimal server bundle rather than the whole workspace.

- [ ] **Step 4: Write the full Compose file**

`docker-compose.yml` extends the dev services with:

- `migrate`: a one-shot service running `prisma migrate deploy && prisma db seed`, with `depends_on: postgres: condition: service_healthy`, and `restart: 'no'`.
- `api`: `depends_on` on `migrate` with `condition: service_completed_successfully`, on `redis` and `rabbitmq` with `service_healthy`; healthcheck curling `/api/v1/health`; port `3001:3001`.
- `worker`: the same dependencies; no ports; healthcheck is a process check.
- `web`: `depends_on: api: service_healthy`; port `3000:3000`; `API_INTERNAL_URL=http://api:3001/api/v1` and `NEXT_PUBLIC_API_URL=http://localhost:3001/api/v1`.

`service_completed_successfully` on the migration job is what makes `docker compose up` a single command that works from a clean checkout: the API cannot start against an unmigrated database, and nobody has to know to run migrations first.

- [ ] **Step 5: Run the smoke test to verify it passes**

Run: `docker compose down -v && docker compose up -d --wait && ./scripts/smoke.sh`
Expected: `OK: api, worker seed, web, and docs all responding`

Then verify the pipeline works in the containerised stack by hand: open `http://localhost:3000`, sign in as Alice, submit a clean review, and watch it appear within a second or two.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "build: containerise all three services and add one-command startup

'docker compose up' now brings up a working system from a clean
checkout. Migrations and seeding run as a one-shot job that the API and
worker wait on with service_completed_successfully, so the usual
first-run failure — services healthy, database empty — cannot happen
and no one needs to know the right order to run things in.

Images are multi-stage and run as a non-root user, carrying the built
output and production dependencies rather than the workspace.

The smoke script checks the assembled system: readiness, a non-empty
catalogue, a rendered page, and a served OpenAPI document. The
catalogue check is the one that matters, because every container can be
healthy while the seed silently never ran."
```

---

### Task 9: Continuous integration

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `.github/pull_request_template.md`

**Interfaces:**
- Produces: CI running on push and pull request with three jobs — `quality` (lint, typecheck, unit), `integration` (Testcontainers), and `e2e` (Compose plus Playwright).

- [ ] **Step 1: Write the workflow**

```yaml
name: CI
on:
  push: { branches: [main] }
  pull_request:
jobs:
  quality:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version-file: '.nvmrc', cache: 'pnpm' }
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm typecheck
      - run: pnpm test:unit

  integration:
    runs-on: ubuntu-latest
    steps:
      # same setup, then:
      - run: pnpm test:integration
        env: { TESTCONTAINERS_RYUK_DISABLED: 'true' }

  e2e:
    runs-on: ubuntu-latest
    steps:
      # same setup, then:
      - run: docker compose up -d --wait
      - run: ./scripts/smoke.sh
      - run: pnpm exec playwright install --with-deps chromium
      - run: pnpm test:e2e
      - if: failure()
        uses: actions/upload-artifact@v4
        with: { name: playwright-report, path: apps/web/playwright-report }
      - if: always()
        run: docker compose logs --no-color > compose-logs.txt
```

The jobs are separate rather than sequential steps so a lint failure reports in under a minute instead of behind a container pull, and so the three failure modes are distinguishable at a glance.

Uploading the Playwright report and the Compose logs on failure is what makes a red CI run diagnosable without reproducing it locally.

- [ ] **Step 2: Verify it passes**

Push the branch and confirm all three jobs are green. Then deliberately break one test, push, and confirm CI fails in the expected job — a pipeline that has never gone red has not been shown to work.

Run locally first: `pnpm lint && pnpm typecheck && pnpm test:unit && pnpm test:integration`

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "ci: run lint, unit, integration, and end-to-end checks

Three separate jobs rather than one sequence, so a lint error reports
in under a minute instead of behind a container pull, and so a red run
says which layer broke before anyone opens the log.

On failure the run uploads the Playwright report and the Compose logs,
which is the difference between diagnosing a CI failure and trying to
reproduce it locally."
```

---

### Task 10: README and architecture decision records

**Files:**
- Create: `README.md`
- Create: `docs/adr/0001-modular-monolith-over-microservices.md`, `0002-transactional-outbox.md`, `0003-recomputed-projections.md`, `0004-identity-columns-over-bigserial.md`, `0005-cursor-pagination.md`
- Modify: `docs/design/2026-09-13-product-reviews-design.md` (add a line pointing at the ADRs)

**Interfaces:**
- Produces: documentation sufficient for a developer who has never seen the project to run it, understand why it is shaped this way, and extend it.

- [ ] **Step 1: Write the README**

Sections, in this order:

1. **What this is** — two sentences and a screenshot of the product page.
2. **Quick start** — `git clone`, `cp .env.example .env`, `docker compose up`, open `http://localhost:3000`. Then the seeded logins in a table with their roles, and the URLs for the API, `/docs`, and the RabbitMQ management UI. Nothing above this section that a reader must get through first.
3. **How it works** — the write-path diagram from the design document as a Mermaid graph, and a paragraph naming the three processes.
4. **Try the interesting bits** — a short numbered walkthrough: submit a clean review and watch it publish within a second; submit one in capitals and find it in the moderator queue; open the RabbitMQ UI and watch the queues; stop the worker, submit a review, see it sit in the outbox, restart the worker and watch it drain. That last one demonstrates the outbox in thirty seconds better than any paragraph.
5. **Development** — running without containers, running tests at each level, applying migrations, regenerating the client.
6. **Design decisions and trade-offs** — a short paragraph per ADR with a link, plus the honest section: the outbox is more machinery than this traffic needs, here is why it is here anyway, and here is when I would have started without it.
7. **What I would do next** — full-text search, soft deletes for the moderation audit trail, incremental projections with reconciliation, OpenTelemetry traces spanning API and worker, review images, and refresh tokens. Framed as a prioritised list with a sentence of reasoning each, not a wish list.
8. **Project structure** — the directory tree with one line per entry.

Keep the tone factual. Every claim in the README must be something a reader can verify by running the project.

- [ ] **Step 2: Write the ADRs**

Each is short and follows the same shape: Context, Decision, Consequences, Alternatives considered. One page at most. The value is in "Alternatives considered" — an ADR that lists no rejected option records nothing.

`0004` records what Prisma actually did with the identity column during Plan 1 Task 4, including the fallback if it fought back.

- [ ] **Step 3: Verify the documentation is accurate**

This is a real step, not a formality. On a clean clone in a temporary directory, follow the Quick start exactly as written, with no prior knowledge applied:

```bash
git clone <repo-url> /tmp/verify-readme && cd /tmp/verify-readme
cp .env.example .env
docker compose up -d --wait
./scripts/smoke.sh
```

Then walk through every numbered step of "Try the interesting bits" and confirm each one behaves as described. Fix the README, not your memory, wherever they disagree. Documentation that was accurate when written and is not verified before delivery is the single most common way a well-built project reads as careless.

- [ ] **Step 4: Check for stray references**

Run: `git grep -niE 'TODO|FIXME|XXX|placeholder|lorem'`
Expected: no matches in shipped source or documentation. Drafting leftovers are the cheapest thing to remove and among the first things a reader notices in a public repository.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "docs: add README and architecture decision records

The README opens with a quick start that has been run from a clean
clone rather than written from memory, and every claim in it is
something the reader can check by running the project.

It includes a short walkthrough of the parts that are otherwise
invisible — stopping the worker, submitting a review, watching it wait
in the outbox, and watching it drain on restart. Thirty seconds of that
explains the design better than the paragraph next to it.

The ADRs record the alternatives that were rejected, not only the
choices that were made, since the rejected option is what a future
reader actually needs in order to revisit a decision. The trade-offs
section says plainly where this design is heavier than the traffic
warrants and what would justify simplifying it."
```

---

## Plan 3 self-review

**Spec coverage.** §8 frontend: catalogue → Task 2; product detail with histogram filter and sort → Task 3; submission and the pending-review panel → Task 4; voting → Task 5; moderation queue → Task 6; httpOnly cookie session → Task 1. §9 E2E → Task 7. The "easy to set up" requirement from the project's stated grading criteria → Task 8, verified by a smoke script rather than asserted. CI → Task 9. The documentation requirement → Task 10, with a verification step that runs the quick start from a clean clone.

**Placeholder scan.** No task defers work to a later unnamed change. Each test list names concrete cases with concrete expected values; the two places using prose rather than literal code (Task 6's queue cases, Task 3's list states) enumerate exact states and behaviours rather than saying "handle edge cases".

**Type consistency.** `apiFetch` (Task 1) is the only network entry point and is used by every hook in Tasks 3–6. `SessionUser` comes from `sessionUserDtoSchema` in `@reviews/contracts` (Plan 1 Task 3), not redefined. `createReviewInputSchema` drives both the form validation in Task 4 and the API validation in Plan 1 Task 10, which is the point of putting it in a shared package. `cacheKeys` is untouched here — the web app has no cache of its own beyond React Query. `data-testid` values used in Task 7's specs (`review-list`, `review-item`, `review-rating`, `your-review`, `rating-summary`) are introduced in Tasks 3 and 4 and listed in Task 7 Step 3 so neither side invents its own.

**One risk worth naming.** Task 7's specs address a seeded product by slug. The seeded slug is `smart-led-desk-lamp` — note that Plans 1 and 2 use a bare `desk-lamp` in their integration tests, but those *create* the product themselves rather than relying on the seed, so the two are unrelated and the resemblance is a trap. An e2e spec navigating to `/products/desk-lamp` gets a 404. If the seed changes, three files break at once — which is why the E2E global setup resets to the seed rather than creating its own fixtures, and why the smoke script asserts the catalogue is non-empty before Playwright runs.
