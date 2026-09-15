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
  // One retry, not two. These specs have never run on CI, so there is no
  // measured flake rate to justify a wider margin — but "no data" is not
  // the same as "provably zero", and a red first run for an undiagnosed
  // reason is worse than absorbing one retry. The report is uploaded on
  // success as well as failure, so a retried pass still leaves a trace.
  retries: process.env.CI ? 1 : 0,
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
