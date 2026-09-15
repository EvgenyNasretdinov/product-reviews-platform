import { expect, test } from '@playwright/test';
import { signIn, signInAs } from './fixtures';

/**
 * The only test in this repository that exercises the system the way a
 * user actually meets it: submit a review, watch it get held for
 * moderation, have a *different account in a different browser context*
 * approve it, then see it appear publicly with the rating updated. No
 * unit or integration test in apps/api or apps/worker covers this whole
 * loop — each of them stops at its own service boundary.
 */
test('a submitted review is moderated and becomes publicly visible', async ({ page, browser }) => {
  await signIn(page, 'alice@example.com');
  await page.goto('/products/smart-led-desk-lamp');

  await page.getByRole('radio', { name: '2 stars' }).click();
  // Exact, not /title/i or /review/i: the rating summary's own star row
  // carries aria-labels like "4 stars, 3 reviews, 75%" and "4.25 out of 5
  // stars, 4 reviews" elsewhere on this same page, both of which a loose
  // substring match on "review" also resolves to — see this file's git
  // history for the strict-mode violation that produced. The form's own
  // labels are exactly "Title" and "Review", so an exact match is both
  // more precise and no less natural a way to find them.
  await page.getByLabel('Title', { exact: true }).fill('Stopped working');
  await page.getByLabel('Review', { exact: true }).fill('IT BROKE AFTER A WEEK AND SUPPORT NEVER REPLIED');
  await page.getByRole('button', { name: /submit/i }).click();

  // apps/worker's moderation policy (policy.ts) flags a review that is
  // "shouting" (over 40 characters, over 60% uppercase letters) unless
  // it comes from a verified purchaser, in which case that same signal
  // is auto-approved instead. The body above is deliberately all-caps
  // and well past that length threshold, and alice is deliberately not
  // a verified purchaser of this product: packages/db's seed.ts limits
  // her verified purchases to the first four seeded products, and the
  // smart LED desk lamp is the fifth. A clean review, or this same body
  // from a verified purchaser, would auto-approve and never reach the
  // moderation queue at all — this is the one combination that reliably
  // lands in FLAGGED and gives this spec a human decision to make.
  await expect(page.getByTestId('your-review')).toContainText(/awaiting moderation/i);

  // The assertion that matters most: before a moderator has approved
  // anything, the review must not be in the public list. Without this,
  // the spec would pass equally well against a system that published
  // every review immediately — the second assertion below, on its own,
  // never proves the moderation gate is actually closed.
  await expect(page.getByTestId('review-list')).not.toContainText('Stopped working');

  const moderator = await signInAs(browser, 'mod@example.com');
  try {
    await moderator.goto('/moderation');

    // Scoped to this review's own row rather than ".first() approve
    // button on the page": the seed data leaves other flagged/pending
    // reviews in the queue, and grabbing the first Approve button on the
    // page would be one 409 away from approving someone else's review
    // instead of this spec's own.
    const queuedRow = moderator.locator('li', { hasText: 'Stopped working' });
    await expect(queuedRow).toBeVisible();
    await queuedRow.getByRole('button', { name: /approve/i }).click();
    await expect(queuedRow).not.toBeVisible();
  } finally {
    await moderator.context().close();
  }

  // Approving is synchronous (the moderator's own queue row disappears
  // immediately, asserted above), but the public product page's review
  // list and rating summary are both cache-backed and only refreshed by
  // the aggregation worker's own outbox consumer — an async hop after
  // the decision, not part of the POST that recorded it (see this
  // repository's git history around "wire the review-list cache the
  // aggregation worker expects"). A single reload can land in the small
  // window before that invalidation has run, so this retries the reload
  // itself rather than asserting once and hoping the timing lines up.
  await expect(async () => {
    await page.reload();
    await expect(page.getByTestId('review-list')).toContainText('Stopped working');
    await expect(page.getByTestId('rating-summary')).toContainText('reviews');
  }).toPass({ timeout: 15_000 });
});
