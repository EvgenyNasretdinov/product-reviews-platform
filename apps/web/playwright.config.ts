import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:3000';

/**
 * End-to-end config for the storefront, run against a live Compose stack
 * (Postgres, Redis, RabbitMQ, the API, and — for the lifecycle spec's
 * automatic moderation — the worker), not against any mocked layer.
 *
 * `globalSetup` (./e2e/global-setup.ts) is what makes the suite
 * repeatable without a database reset: see that file's doc comment for
 * why a reset isn't available here and what it does instead.
 */
export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  // Only for local runs: in CI the whole stack (infra, API, worker, web)
  // is started by the workflow before Playwright ever runs, and pointing
  // this at a second `next dev`/`next start` there would just race it.
  // Locally, `reuseExistingServer` means a web app someone already has
  // running (the common case while iterating) is left alone rather than
  // fighting it for port 3000.
  webServer: process.env.CI
    ? undefined
    : {
        command: 'pnpm start:dev',
        url: baseURL,
        reuseExistingServer: true,
        timeout: 120_000,
      },
});
