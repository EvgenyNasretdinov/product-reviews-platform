// Shared Vitest setup for @reviews/db integration tests.
//
// Testcontainers pulls the `postgres:17-alpine` image on first run, which can
// take longer than the default test timeout on a cold Docker cache. The
// per-file timeouts are set in vitest.config.ts; this file exists as the
// single place to add shared matchers or global hooks as the test suite
// grows.
export {};
