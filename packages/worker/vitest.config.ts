import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // DB-backed suites share one TEST_DATABASE_URL and clean up their own rows:
    // running files in parallel let one file's cleanup race another's fixtures.
    fileParallelism: false,
    environment: 'node',
    globals: true,
    // Vitest 4+ no longer skips dist/ by default; tsc emits compiled tests there.
    exclude: [...configDefaults.exclude, '**/dist/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
  },
});
