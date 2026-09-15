import { expect, test } from '@playwright/test';

test('a guest can browse the catalogue and read reviews', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /products/i })).toBeVisible();

  await page.getByRole('link', { name: /desk lamp/i }).click();
  // The product page renders this same "X out of 5 stars" star rating
  // twice — once in the header, once in the reviews section's own
  // summary — so `.first()` is what keeps this a sanity check ("a star
  // rating renders here, accessibly") rather than a strict-mode failure
  // over which of two equivalent elements it happened to find.
  await expect(
    page.getByRole('img', { name: /out of 5 stars/ }).first(),
  ).toBeVisible();

  await page.getByRole('button', { name: /5 stars/ }).click();
  await expect(page).toHaveURL(/rating=5/);
  for (const stars of await page.getByTestId('review-rating').all()) {
    await expect(stars).toHaveAttribute('aria-label', /5 out of 5/);
  }

  await page.getByRole('combobox', { name: /sort/i }).selectOption('newest');
  await expect(page.getByTestId('review-item').first()).toBeVisible();
});
