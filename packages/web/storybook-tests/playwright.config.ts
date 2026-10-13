import { defineConfig } from '@playwright/test';

/**
 * Story tests against the built Storybook (pnpm build-storybook first).
 *
 * - every story, light and dark: an axe scan (WCAG 2.x A/AA)
 * - the sliding-pill geometry of SegmentedControl and Tabs (geometry.pw.ts)
 * - every story, light and dark, DPR 2: a screenshot against the committed
 *   baseline. Baselines are rendered on Linux in the official Playwright
 *   image (the CI job runs in the same image), so screenshots are compared
 *   only on Linux unless STORYBOOK_VISUAL=1; STORYBOOK_VISUAL=0 turns them off.
 *
 * On a Mac it drives the installed Chrome (never a downloaded browser); in
 * the Linux image it uses the image's bundled Chromium.
 */
const linux = process.platform === 'linux';

export default defineConfig({
  testDir: '.',
  // *.pw.ts, so Vitest (which runs *.spec.ts / *.test.ts) never picks them up
  testMatch: '*.pw.ts',
  snapshotPathTemplate: '{testDir}/__screenshots__/{arg}{ext}',
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: '../storybook-test-report' }]] : 'list',
  outputDir: '../storybook-test-results',
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.001, threshold: 0.15, animations: 'disabled', caret: 'hide', scale: 'device' } },
  use: {
    baseURL: 'http://127.0.0.1:6007',
    ...(linux ? {} : { channel: 'chrome' }),
    headless: true,
    reducedMotion: 'reduce',
  },
  webServer: { command: 'node storybook-tests/serve.mjs', url: 'http://127.0.0.1:6007/index.json', reuseExistingServer: !process.env.CI, cwd: '..' },
});
