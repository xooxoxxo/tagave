import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // DB-backed suites share one TEST_DATABASE_URL and clean up their own rows:
    // running files in parallel let one file's cleanup race another's fixtures.
    fileParallelism: false, environment: 'node', globals: true, include: ['src/**/*.test.ts'] },
});
