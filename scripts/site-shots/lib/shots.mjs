/**
 * The captures: each shot is a page, a few clicks to set it up, and a frame.
 * Taken at 2x and scaled down (sharper text than a 1x capture), in light and
 * dark, then written as site/img/<name>-<theme>-<1600|800>.webp.
 */
import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const THEMES = ['light', 'dark'];
const WIDTH = 1600;

/** In capture order: the compilation pieces are merged after their shot (hooks), so the grid shows one Trainspotting. */
export const SHOTS = ['compilation', 'albums', 'plan', 'gaps', 'album', 'reviews'];

async function loadDeps(repo) {
  const fromWeb = createRequire(path.join(repo, 'packages/web/package.json'));
  const fromTest = createRequire(fromWeb.resolve('@playwright/test/package.json'));
  const playwright = (await import(pathToFileURL(fromTest.resolve('playwright')).href)).default;
  const fromWorker = createRequire(path.join(repo, 'packages/worker/package.json'));
  const sharp = (await import(pathToFileURL(fromWorker.resolve('sharp')).href)).default;
  return { chromium: playwright.chromium, sharp };
}

/** Covers decoded, fonts in, nothing loading, no spinner or skeleton left. */
async function settle(page) {
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.evaluate(() => document.fonts.ready);
  const ok = await page.waitForFunction(() => {
    const imgs = [...document.images].filter((i) => {
      const r = i.getBoundingClientRect();
      return r.width > 0 && r.bottom > 0 && r.top < innerHeight;
    });
    const busy = document.querySelector('[aria-busy="true"], [class*="skeleton" i], [role="progressbar"]');
    return imgs.every((i) => i.complete && i.naturalWidth > 0) && !busy;
  }, null, { timeout: 30_000 }).then(() => true, () => false);
  if (!ok) throw new Error(`${page.url()}: images or loading states did not settle in 30s`);
  await page.waitForTimeout(1200);
}

/** Refuse a frame with an error, a warning banner or anything from this machine in it. */
async function assertClean(page, name) {
  const bad = await page.evaluate(() => {
    const text = document.body.innerText;
    const problems = [];
    for (const re of [/something went wrong/i, /could not be/i, /failed to/i, /no worker is running/i, /disk is filling/i, /update available/i, /\/Users\//, /\/var\/folders\//, /\/private\//, /\.local\b/]) {
      if (re.test(text)) problems.push(String(re));
    }
    if (document.querySelector('[role="alert"]:not(:empty)')) problems.push('an alert is showing');
    return problems;
  });
  if (bad.length) throw new Error(`shot "${name}" is not clean: ${bad.join(', ')}`);
}

/** Scroll the element's scrolling ancestor so it sits `top` px below the viewport top. */
async function scrollTo(locator, top) {
  await locator.evaluate((el, y) => {
    let s = el.parentElement;
    while (s && !(s.scrollHeight > s.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(s).overflowY))) s = s.parentElement;
    (s ?? document.scrollingElement).scrollBy(0, el.getBoundingClientRect().top - y);
  }, top);
}

export async function captureShots({ repo, stack, session, outDir, only, log, runDir, hooks = {} }) {
  const { chromium, sharp } = await loadDeps(repo);
  const want = (n) => !only || only.includes(n);
  const browser = await chromium.launch();
  const written = [];
  const ids = session.ids;

  const frames = {
    compilation: {
      height: 1000,
      url: `/albums/${ids.compilationPiece}`,
      async setup(page) {
        await page.getByRole('button', { name: /look like part of this one/i }).first().click();
        await page.waitForTimeout(800);
      },
    },
    // a wall of covers: a little more compression keeps it near the others in size
    albums: { height: 1000, url: '/albums?sort=year', quality: 76 },
    plan: {
      height: 1000,
      url: `/plans/${ids.planId}`,
      async setup(page) {
        const row = page.getByText(ids.planFile, { exact: true }).first();
        await row.click();
        await page.waitForTimeout(800);
      },
    },
    gaps: { height: 720, url: '/work?tab=attention' },
    album: { height: 1000, url: `/albums/${ids.featureAlbum}?tab=about` },
    reviews: {
      height: 1000,
      url: `/albums/${ids.featureAlbum}?tab=about`,
      async setup(page) {
        await scrollTo(page.getByText('Your rating', { exact: true }).first(), 250);
      },
    },
  };

  try {
    for (const name of SHOTS) {
      if (want(name)) {
        const f = frames[name];
        for (const theme of THEMES) {
          const ctx = await browser.newContext({
            viewport: { width: WIDTH, height: f.height },
            deviceScaleFactor: 2,
            colorScheme: theme,
            reducedMotion: 'reduce',
            baseURL: stack.baseUrl,
          });
          await ctx.addCookies(session.api.cookies().map((c) => ({ ...c, url: stack.baseUrl })));
          await ctx.addInitScript((t) => {
            try { localStorage.setItem('tagave-theme', t); } catch { /* the emulated colour scheme still applies */ }
          }, theme);
          const page = await ctx.newPage();
          await page.goto(f.url);
          await settle(page);
          if (f.setup) {
            await f.setup(page);
            await settle(page);
          }
          await page.mouse.move(WIDTH - 2, f.height - 2); // no hover state inside the frame
          await page.waitForTimeout(300);
          await assertClean(page, name);
          const png = await page.screenshot({ animations: 'disabled', caret: 'hide' });
          await writeFile(path.join(runDir, `${name}-${theme}.png`), png);
          for (const w of [1600, 800]) {
            const file = path.join(outDir, `${name}-${theme}-${w}.webp`);
            const buf = await sharp(png).resize({ width: w, kernel: 'lanczos3' }).webp({ quality: f.quality ?? 82, effort: 6, smartSubsample: true }).toBuffer();
            await writeFile(file, buf);
            written.push({ file: path.relative(repo, file), bytes: buf.length });
          }
          await ctx.close();
          log(`  ${name} (${theme})`);
        }
      }
      if (hooks[name]) await hooks[name]();
    }
  } finally {
    await browser.close();
  }
  return written;
}
