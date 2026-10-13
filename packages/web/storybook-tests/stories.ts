import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';

export interface StoryEntry { id: string; title: string; name: string; type: 'story' | 'docs'; tags: string[] }

/** Every story in the built Storybook's index. */
export function stories(): StoryEntry[] {
  const index = JSON.parse(readFileSync(new URL('../storybook-static/index.json', import.meta.url), 'utf8')) as { entries: Record<string, StoryEntry> };
  return Object.values(index.entries).filter((e) => e.type === 'story');
}

export type Theme = 'light' | 'dark';

/** Opens one story in the bare iframe and waits until it has rendered, played and its fonts have loaded. */
export async function openStory(page: Page, id: string, theme: Theme, globals: Record<string, string> = {}): Promise<void> {
  // Chromium's screenshot re-applies the device metrics, which fires a resize
  // event although nothing changed size; an open Menu closes on resize. Pass
  // resize events on only when the window really changed.
  await page.addInitScript(() => {
    let last = `${innerWidth}x${innerHeight}`;
    addEventListener('resize', (event) => {
      const now = `${innerWidth}x${innerHeight}`;
      if (now === last) event.stopImmediatePropagation();
      last = now;
    }, { capture: true });
  });
  // a play function that throws only logs to the console: collect errors
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(m.text()); });
  const g = Object.entries({ theme, ...globals }).map(([k, v]) => `${k}:${v}`).join(';');
  await page.goto(`/iframe.html?id=${encodeURIComponent(id)}&viewMode=story&globals=${encodeURIComponent(g)}`);
  await page.waitForFunction(() => {
    const preview = (window as unknown as { __STORYBOOK_PREVIEW__?: { currentRender?: { phase?: string } } }).__STORYBOOK_PREVIEW__;
    const phase = preview?.currentRender?.phase;
    return phase === 'completed' || phase === 'finished' || phase === 'errored' || phase === 'aborted';
  }, undefined, { timeout: 15_000 });
  await page.evaluate(() => document.fonts.ready);
  const failed = await page.evaluate(() => document.body.classList.contains('sb-show-errordisplay'));
  if (failed) throw new Error(`story ${id} failed to render: ${await page.locator('#error-message').innerText().catch(() => '')}`);
  if (errors.length) throw new Error(`story ${id} logged errors:\n${errors.join('\n').slice(0, 2000)}`);
  // let ResizeObservers, layout effects and the sliding pill settle
  await page.waitForTimeout(150);
}
