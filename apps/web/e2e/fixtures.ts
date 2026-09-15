import { expect, type Browser, type Page } from '@playwright/test';

/** Every seeded account (see packages/db/prisma/seed.ts) shares this password. */
export const SEED_PASSWORD = 'password123';

/**
 * Signs `page` in through the real login form — filling the email/password
 * fields and submitting, not the page's "one-click seeded account" dev
 * shortcuts (`LoginForm`'s `SEEDED_ACCOUNTS` buttons). Going through the
 * actual fields is what makes this helper work for any account, seeded or
 * not, and it exercises the same path a real visitor takes rather than a
 * debug-only affordance that a production build might not even ship.
 */
export async function signIn(page: Page, email: string, password: string = SEED_PASSWORD): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL('/');
}

/**
 * Signs in as `email` inside a brand-new browser context — a separate
 * cookie jar, so this session and whatever `page` is signed in as (if
 * anything) genuinely coexist, the same way a customer's tab and a
 * moderator's tab would in two different browser profiles. The lifecycle
 * spec needs exactly this: alice submits a review in one context, and a
 * moderator has to see and act on it from a second, independent one.
 */
export async function signInAs(browser: Browser, email: string, password: string = SEED_PASSWORD): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, email, password);
  return page;
}
