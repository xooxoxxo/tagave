/**
 * The sliding pill of SegmentedControl and Tabs sits dead centre: on its
 * item, with equal gaps in the track, and with the label optically centred
 * in it, at DPR 1 and 2, in both themes, in every state that used to drift
 * (fonts loading, a sheet opening, a switch, a resize).
 *
 * "Centred" is checked twice: in layout (rects of the three pill parts
 * against the item and the track) and visually, from pixels: the label's
 * capitals (cap top to baseline) against the painted pill, and how much the
 * drop shadow tints the gap under the pill compared with the gap above.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { openStory, type Theme } from './stories';

const TRACKS = '[role="radiogroup"], [role="tablist"]';

interface Layout {
  pillVsItem: { left: number; right: number; top: number; bottom: number };
  pillInTrack: { top: number; bottom: number; left: number; right: number };
  /** the label box (trimmed to the cap band) against the item, vertically */
  labelVsItem: number;
  firstSelected: boolean;
  lastSelected: boolean;
  ready: boolean;
}

/** Layout geometry of every track on the page (CSS px, screen space). */
async function layouts(page: Page): Promise<Layout[]> {
  return page.$$eval(TRACKS, (tracks) => tracks.map((track) => {
    const r = (el: Element) => el.getBoundingClientRect();
    const parts = [...track.querySelectorAll('[data-part]')].map(r);
    const pill = { left: Math.min(...parts.map((p) => p.left)), right: Math.max(...parts.map((p) => p.right)), top: Math.min(...parts.map((p) => p.top)), bottom: Math.max(...parts.map((p) => p.bottom)) };
    const items = [...track.querySelectorAll(':scope > label, :scope > button')];
    const active = track.querySelector('[data-active="true"]')!;
    const a = r(active);
    const t = r(track);
    const cs = getComputedStyle(track);
    // the track's scale on screen (a sheet that is still scaling in)
    const s = t.width / parseFloat(cs.width);
    const inner = { left: t.left + parseFloat(cs.paddingLeft) * s, right: t.right - parseFloat(cs.paddingRight) * s, top: t.top + parseFloat(cs.paddingTop) * s, bottom: t.bottom - parseFloat(cs.paddingBottom) * s };
    return {
      pillVsItem: { left: pill.left - a.left, right: pill.right - a.right, top: pill.top - a.top, bottom: pill.bottom - a.bottom },
      pillInTrack: { top: (pill.top - inner.top) / s, bottom: (inner.bottom - pill.bottom) / s, left: (pill.left - inner.left) / s, right: (inner.right - pill.right) / s },
      labelVsItem: (() => { const l = active.querySelector(':scope > span')!.getBoundingClientRect(); return (l.top + l.bottom) / 2 - (a.top + a.bottom) / 2; })(),
      firstSelected: items[0] === active,
      lastSelected: items[items.length - 1] === active,
      ready: (track as HTMLElement).dataset['indicator'] === 'ready',
    };
  }));
}

function expectCentred(list: Layout[], what: string) {
  expect(list.length, `${what}: no tracks`).toBeGreaterThan(0);
  for (const [i, g] of list.entries()) {
    const at = `${what}, track ${i}`;
    expect(g.ready, `${at}: pill placed`).toBe(true);
    // on its item, to the hundredth of a pixel (offsetWidth rounding was up to 0.55px)
    for (const [side, d] of Object.entries(g.pillVsItem)) expect(Math.abs(d), `${at}: pill ${side} vs item`).toBeLessThan(0.02);
    // the label box sits in the middle of its item (the pixel check below confirms what is painted)
    expect(Math.abs(g.labelVsItem), `${at}: label box vs item centre`).toBeLessThan(0.02);
    // equal gaps above and below
    expect(Math.abs(g.pillInTrack.top - g.pillInTrack.bottom), `${at}: gap above vs below`).toBeLessThan(0.02);
    // an end item: the side gap matches the top gap
    if (g.firstSelected) expect(Math.abs(g.pillInTrack.left - g.pillInTrack.top), `${at}: left gap`).toBeLessThan(0.02);
    if (g.lastSelected) expect(Math.abs(g.pillInTrack.right - g.pillInTrack.top), `${at}: right gap`).toBeLessThan(0.02);
  }
}

/** Pixel analysis in the page: two (or three) screenshots of the same clip, decoded on a canvas. */
async function pixelCentring(page: Page, track: Locator, dpr: number) {
  const box = (await track.boundingBox())!;
  const clip = { x: Math.floor(box.x - 4), y: Math.floor(box.y - 4), width: Math.ceil(box.width + 8), height: Math.ceil(box.height + 8) };
  const style = async (css: string) => page.evaluate((css) => {
    let s = document.getElementById('geometry-probe');
    if (!s) { s = document.createElement('style'); s.id = 'geometry-probe'; document.head.append(s); }
    s.textContent = css;
  }, css);
  const shot = async () => (await page.screenshot({ clip, animations: 'disabled', scale: 'device' })).toString('base64');
  await style('');
  const withAll = await shot();
  // only the label goes transparent (a tab's count badge stays in both shots)
  await style('[data-active="true"] > span:not([class*="count"]) { color: transparent !important; }');
  const noLabel = await shot();
  await style('span:has(> [data-part]) { opacity: 0 !important; }');
  const noPill = await shot();
  await style('');
  const geometry = await track.evaluate((el, clip) => {
    const parts = [...el.querySelectorAll('[data-part]')].map((p) => p.getBoundingClientRect());
    const t = el.getBoundingClientRect();
    return { pillTop: Math.min(...parts.map((p) => p.top)) - clip.y, pillBottom: Math.max(...parts.map((p) => p.bottom)) - clip.y, pillLeft: Math.min(...parts.map((p) => p.left)) - clip.x, pillRight: Math.max(...parts.map((p) => p.right)) - clip.x, trackTop: t.top - clip.y, trackBottom: t.bottom - clip.y };
  }, clip);
  return page.evaluate(async ({ shots, g, dpr }) => {
    const load = (b64: string) => new Promise<ImageData>((res) => {
      const img = new Image();
      img.onload = () => { const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const ctx = c.getContext('2d')!; ctx.drawImage(img, 0, 0); res(ctx.getImageData(0, 0, img.width, img.height)); };
      img.src = `data:image/png;base64,${b64}`;
    });
    const [A, L, P] = await Promise.all(shots.map(load)) as [ImageData, ImageData, ImageData];
    const W = A.width;
    const diff = (X: ImageData, Y: ImageData, x: number, y: number) => { const i = (y * W + x) * 4; return Math.abs(X.data[i]! - Y.data[i]!) + Math.abs(X.data[i + 1]! - Y.data[i + 1]!) + Math.abs(X.data[i + 2]! - Y.data[i + 2]!); };
    const D = (v: number) => Math.round(v * dpr);
    // the label's ink inside the pill
    const x0 = D(g.pillLeft), x1 = D(g.pillRight), y0 = D(g.pillTop), y1 = D(g.pillBottom);
    const ink: boolean[][] = [];
    let minX = Infinity;
    for (let y = y0; y < y1; y++) { const row: boolean[] = []; for (let x = x0; x < x1; x++) { const on = diff(A, L, x, y) > 60; row.push(on); if (on) minX = Math.min(minX, x); } ink.push(row); }
    // The cap band is read off the first glyph alone: every label starts with
    // a capital, and a capital has no descender, so its ink runs from cap
    // height to the baseline (an O overshoots both ends alike). An earlier
    // version took the baseline as the most common bottom of all ink columns;
    // in "Off" the columns under the f's crossbars and hooks outnumber the
    // stems at DPR 2 on Linux, so it read the crossbar as the baseline and
    // reported the label 2.75px off. It is kept as `legacyOffset` for the
    // diagnostics only.
    const colHas = (x: number) => ink.some((row) => row[x - x0]);
    let end = minX; while (end < x1 && colHas(end)) end++;
    let capTop = Infinity, capBottom = -Infinity;
    for (let x = minX; x < end; x++) for (let y = y0; y < y1; y++) if (ink[y - y0]![x - x0]) { capTop = Math.min(capTop, y); capBottom = Math.max(capBottom, y + 1); }
    const capCentre = (capTop + capBottom) / 2 / dpr;
    const bottoms = new Map<number, number>();
    for (let x = x0; x < x1; x++) { let b = -1; for (let y = y0; y < y1; y++) if (ink[y - y0]![x - x0]) b = y; if (b >= 0) bottoms.set(b, (bottoms.get(b) ?? 0) + 1); }
    const legacyBaseline = [...bottoms.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]![0] + 1;
    const bottomHistogram = [...bottoms.entries()].sort((a, b) => a[0] - b[0]).map(([row, n]) => `${row - y0}:${n}`).join(' ');
    const pillCentre = (g.pillTop + g.pillBottom) / 2;
    // how strongly the pill (shadow included) tints the gap above and below, at its centre column
    const cx = Math.round((x0 + x1) / 2);
    const tint = (a: number, b: number) => { let s = 0, n = 0; for (let y = a; y < b; y++) { s += diff(A, P, cx, y); n++; } return n ? s / n : 0; };
    const above = tint(Math.ceil(g.trackTop * dpr) + dpr, y0);
    const below = tint(y1 + 1, Math.floor(g.trackBottom * dpr) - dpr);
    return {
      labelOffset: capCentre - pillCentre, above, below,
      diagnostics: { dpr, pillRows: [y0, y1], firstGlyphColumns: [minX - x0, end - x0], capTop: capTop - y0, capBottom: capBottom - y0, legacyBaseline: legacyBaseline - y0, legacyOffset: ((capTop + legacyBaseline) / 2 / dpr) - pillCentre, bottomHistogram },
    };
  }, { shots: [withAll, noLabel, noPill], g: geometry, dpr }).then((r) => ({ ...r, shot: withAll }));
}

const STORIES = [
  'components-segmentedcontrol--playground',
  'components-segmentedcontrol--last-selected',
  'components-segmentedcontrol--three-options',
  'components-segmentedcontrol--small',
  'components-segmentedcontrol--gallery',
  'components-tabs--playground',
  'components-tabs--with-counts',
];

for (const theme of ['light', 'dark'] as Theme[]) {
  for (const dpr of [1, 2]) {
    test.describe(`${theme}, DPR ${dpr}`, () => {
      test.use({ deviceScaleFactor: dpr, viewport: { width: 900, height: 600 }, reducedMotion: 'no-preference' });

      for (const id of STORIES) {
        test(`${id}: pill on its item, label optically centred`, async ({ page }, testInfo) => {
          await openStory(page, id, theme);
          expectCentred(await layouts(page), id);
          const tracks = page.locator(TRACKS);
          for (let i = 0; i < await tracks.count(); i++) {
            const p = await pixelCentring(page, tracks.nth(i), dpr);
            await testInfo.attach(`track-${i}.json`, { body: JSON.stringify({ labelOffset: p.labelOffset, above: p.above, below: p.below, ...p.diagnostics }, null, 1), contentType: 'application/json' });
            if (Math.abs(p.labelOffset) > 0.5) await testInfo.attach(`track-${i}.png`, { body: Buffer.from(p.shot, 'base64'), contentType: 'image/png' });
            // capitals centred in the painted pill within half a pixel (they sat a full pixel high)
            expect(Math.abs(p.labelOffset), `${id} track ${i}: label cap band vs pill centre`).toBeLessThanOrEqual(0.5);
            // the drop never makes the gap below read much darker than the gap above
            expect(p.below, `${id} track ${i}: gap tint below (${p.below.toFixed(1)}) vs above (${p.above.toFixed(1)})`).toBeLessThanOrEqual(p.above * 2.5 + 4);
          }
        });
      }

      test('after switching options and after a resize', async ({ page }) => {
        await openStory(page, 'components-segmentedcontrol--long-labels', theme);
        await page.locator('[role="radiogroup"] label').first().click();
        await page.waitForTimeout(450);
        expectCentred(await layouts(page), 'switched');
        await page.setViewportSize({ width: 611, height: 600 });
        await page.waitForTimeout(200);
        expectCentred(await layouts(page), 'resized');
        await openStory(page, 'components-tabs--playground', theme);
        await page.getByRole('tab', { name: 'Activity' }).click();
        await page.waitForTimeout(450);
        expectCentred(await layouts(page), 'tabs switched');
      });

      test('in a sheet that slides and scales in: right while it opens and after', async ({ page }) => {
        await page.goto('/iframe.html?id=components-segmentedcontrol--in-sheet&viewMode=story&globals=' + encodeURIComponent(`theme:${theme}`));
        await page.waitForSelector('dialog[open] [data-indicator="ready"]');
        const during = await layouts(page);
        await page.waitForTimeout(700);
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        expectCentred(during, 'sheet, mid-animation');
        expectCentred(await layouts(page), 'sheet, settled');
        const p = await pixelCentring(page, page.locator(TRACKS).first(), dpr);
        expect(Math.abs(p.labelOffset), 'sheet: label cap band vs pill centre').toBeLessThanOrEqual(0.5);
      });

      test('before and after the web fonts load', async ({ page }) => {
        let release!: () => void;
        const gate = new Promise<void>((r) => { release = r; });
        await page.route(/\.woff2?(\?.*)?$/, async (route) => { await gate; await route.continue(); });
        await page.goto('/iframe.html?id=components-segmentedcontrol--gallery&viewMode=story&globals=' + encodeURIComponent(`theme:${theme}`));
        await page.waitForSelector('[data-indicator="ready"]');
        expectCentred(await layouts(page), 'fallback font');
        release();
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(200);
        expectCentred(await layouts(page), 'web font');
      });
    });
  }
}
