import { existsSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { openStory, stories, type StoryEntry, type Theme } from './stories';

const wanted = process.env.STORYBOOK_VISUAL === '1' || (process.platform === 'linux' && process.env.STORYBOOK_VISUAL !== '0');
const updating = process.argv.some((a) => a === '--update-snapshots' || a === '-u' || a.startsWith('--update-snapshots='));
// Until baselines are committed (they are rendered in CI, see DESIGN.md), the
// comparison is skipped rather than failing on every story.
const haveBaselines = existsSync(new URL('./__screenshots__/', import.meta.url));
const visualOn = wanted && (haveBaselines || updating);

test.use({ deviceScaleFactor: 2, viewport: { width: 960, height: 640 } });

/** The screenshot comes first: axe scrolls nodes into view, which closes an open menu. */
async function screenshot(page: Page, story: StoryEntry, theme: Theme) {
  const name = `${story.id}--${theme}.png`;
  if (story.tags.includes('shot-viewport') || story.tags.includes('phone')) {
    await expect(page).toHaveScreenshot(name);
    return;
  }
  const box = await page.locator('#storybook-root').boundingBox();
  if (!box) throw new Error(`no root box for ${story.id}`);
  const pad = story.tags.includes('shot-padded') ? 88 : 8;
  const x = Math.max(0, Math.floor(box.x - pad));
  const y = Math.max(0, Math.floor(box.y - pad));
  const clip = { x, y, width: Math.ceil(box.width + 2 * pad), height: Math.ceil(box.height + 2 * pad) };
  await expect(page).toHaveScreenshot(name, { clip, fullPage: true });
}

for (const story of stories()) {
  for (const theme of ['light', 'dark'] as Theme[]) {
    test(`${story.id} · ${theme}`, async ({ page }) => {
      if (story.tags.includes('phone')) await page.setViewportSize({ width: 390, height: 700 });
      else if (story.tags.includes('shot-viewport')) await page.setViewportSize({ width: 720, height: 600 });
      await openStory(page, story.id, theme);

      if (visualOn && !story.tags.includes('no-shot')) await screenshot(page, story, theme);

      // a11y: WCAG 2.x A and AA on the whole document (dialogs and menus render outside the root)
      const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
      const violations = axe.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`);
      expect(violations, `axe violations in ${story.id} (${theme})`).toEqual([]);
      expect(axe.passes.length, 'axe ran').toBeGreaterThan(0);
    });
  }
}
