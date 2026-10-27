import { defineConfig } from '@playwright/test';

/**
 * The phone side of the web app, in a real Chrome:
 *  - installable: the manifest parses, the service worker registers and
 *    controls the page, Chrome reports no installability errors, and
 *    `beforeinstallprompt` fires (against `vite preview`, so build first:
 *    pnpm build);
 *  - background playback: with the tab hidden mid-track, the next track
 *    starts by itself, the equalizer glow on (against `vite dev`, which lets
 *    the test drive the player module directly).
 *
 * pnpm test-pwa. On a Mac it drives the installed Chrome; on Linux,
 * Playwright's Chromium.
 */
const linux = process.platform === 'linux';

export default defineConfig({
  testDir: '.',
  testMatch: '*.pw.ts',
  workers: 1,
  retries: 0,
  reporter: 'list',
  outputDir: '../pwa-test-results',
  use: {
    ...(linux ? {} : { channel: 'chrome' }),
    headless: true,
  },
  webServer: [
    { command: 'pnpm exec vite --host 127.0.0.1 --port 4178 --strictPort', url: 'http://127.0.0.1:4178/', reuseExistingServer: false, cwd: '..' },
    { command: 'pnpm exec vite preview --host 127.0.0.1 --port 4179 --strictPort', url: 'http://127.0.0.1:4179/', reuseExistingServer: false, cwd: '..' },
  ],
});
