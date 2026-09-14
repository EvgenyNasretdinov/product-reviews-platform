// Adds `toBeInTheDocument`, `toHaveTextContent`, etc. to Vitest's `expect`.
// Imported once here (via vitest.config.ts's `setupFiles`) rather than in
// every component test, so a new *.test.tsx file gets the matchers for
// free instead of everyone remembering the import.
import '@testing-library/jest-dom/vitest';
