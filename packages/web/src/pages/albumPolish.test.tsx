import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Tabs } from '../components/ui/Tabs';
import { SegmentedControl } from '../components/ui/SegmentedControl';
import { INDICATOR_MS, indicatorStyle, indicatorTransition } from '../components/ui/useSlidingIndicator';
import { STAR_TARGET, starHitGeometry } from '../components/StarRating';
import { parseAlbumsSearch, apiSearchParams } from './albumsSearch';

const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '');
const read = (rel: string) => stripComments(readFileSync(new URL(rel, import.meta.url), 'utf8'));
const rule = (css: string, selector: string) =>
  [...css.matchAll(new RegExp(`(?:^|\\n)\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'g'))]
    .map((m) => m[1] ?? '').join('\n');

describe('tab strips and segmented controls: the selected pill slides', () => {
  it('a change of selection eases over ~250ms; the first placement and resizes are instant', () => {
    expect(INDICATOR_MS).toBe(250);
    const t = indicatorTransition(true, false);
    expect(t).toMatch(/transform 250ms cubic-bezier\(0\.2, 0\.8, 0\.2, 1\)/);
    expect(t).toMatch(/width 250ms/);
    expect(indicatorTransition(false, false)).toBe('none');
  });

  it('reduced motion: always instant', () => {
    expect(indicatorTransition(true, true)).toBe('none');
    for (const file of ['../components/ui/Tabs.module.css', '../components/ui/SegmentedControl.module.css']) {
      const css = read(file);
      expect(css).toMatch(/prefers-reduced-motion: reduce\)\s*\{[^}]*\.indicator[^}]*\{\s*transition: none/);
    }
  });

  it('places the pill with a transform, never left/top (no layout per frame)', () => {
    expect(indicatorStyle({ x: 120, y: 4, width: 80, height: 40 }, 'none')).toEqual({
      transform: 'translate(120px, 4px)', width: '80px', height: '40px', transition: 'none',
    });
  });

  it('server markup: the active item paints its own bubble until the indicator is placed', () => {
    const tabs = renderToStaticMarkup(<Tabs items={[{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }]} value="b" />);
    expect(tabs).toMatch(/aria-selected="true" data-active="true"/);
    expect(tabs).not.toMatch(/data-indicator/);
    const seg = renderToStaticMarkup(<SegmentedControl label="View" name="v" value="list" onChange={() => undefined} options={[{ value: 'grid', label: 'Grid' }, { value: 'list', label: 'List' }]} />);
    expect(seg).toMatch(/data-active="true"[^>]*><input[^>]*value="list"/);
    const css = read('../components/ui/Tabs.module.css');
    expect(rule(css, '.tablist[data-indicator] .active,\n.tablist[data-indicator] .active:hover')).toMatch(/background: transparent/);
  });

  it('no focus ring on click; a ring for keyboard focus', () => {
    const css = read('../components/ui/Tabs.module.css');
    expect(rule(css, '.tab:focus')).toMatch(/outline: none/);
    expect(rule(css, '.tab:focus-visible')).toMatch(/outline: 2px solid var\(--ring\)/);
  });

  it('the album page uses the shared Tabs strip', () => {
    const tsx = readFileSync(new URL('./AlbumDetailPage.tsx', import.meta.url), 'utf8');
    expect(tsx).toMatch(/<Tabs\s+label="Album sections"/);
    expect(tsx).not.toMatch(/styles\.tabActive/);
  });
});

describe('album header backdrop: full bleed, no hard edges', () => {
  const css = read('./AlbumDetailPage.module.css');

  it('the frame spans the whole pane, from behind the app bar to below the header, and clips the blur', () => {
    const frame = rule(css, '.backdropFrame');
    expect(frame).toMatch(/position: absolute/);
    expect(frame).toMatch(/left: 0/);
    expect(frame).toMatch(/right: 0/);
    expect(frame).toMatch(/top: calc\(-1 \* var\(--album-bar-h, 56px\)\)/);
    expect(frame).toMatch(/overflow: hidden/);
    expect(frame).toMatch(/mask-image: linear-gradient\(to bottom, var\(--canvas\) 0%, var\(--canvas\) 40%, transparent 100%\)/);
  });

  it('the blurred image overhangs the frame by more than its blur, so the sides never fade to white', () => {
    const img = rule(css, '.backdrop');
    const blur = Number(img.match(/blur\((\d+)px\)/)?.[1]);
    const overhang = Number(img.match(/inset: -(\d+)px/)?.[1]);
    expect(overhang).toBeGreaterThanOrEqual(3 * blur);
  });

  it('the band is not held to the content column; the hero inside it is', () => {
    expect(rule(css, '.heroBand')).not.toMatch(/max-width/);
    expect(rule(css, '.hero')).toMatch(/max-width: calc\(var\(--content-max\) - 2 \* var\(--page-pad\)\)/);
    expect(rule(css, '.container')).toMatch(/position: relative/);
  });
});

describe('touch targets', () => {
  it('interactive stars are 44px targets; read-only stars stay compact', () => {
    const g = starHitGeometry(34, true);
    expect(34 + g.gap).toBe(STAR_TARGET);
    expect(34 + 2 * g.reach).toBe(STAR_TARGET);
    expect(starHitGeometry(14, false)).toEqual({ gap: 2, reach: 0 });
  });

  it('attention rows on a phone: the action is a full-width 44px button under the line', () => {
    const css = readFileSync(new URL('./AlbumAttention.module.css', import.meta.url), 'utf8');
    const phone = css.slice(css.indexOf('@media (max-width: 640px)'));
    expect(phone).toMatch(/"action action"/);
    expect(phone).toMatch(/\.actionSlot \.action \{[^}]*width: 100%[^}]*min-height: 44px/);
  });
});

describe('albums filtered by folder', () => {
  it('the folder travels in the URL and on to the API', () => {
    const search = parseAlbumsSearch({ folder: '#/!!!/2013 - Thr!!!Er' });
    expect(search.folder).toBe('#/!!!/2013 - Thr!!!Er');
    expect(apiSearchParams(search).toString()).toBe('folder=%23%2F%21%21%21%2F2013+-+Thr%21%21%21Er');
  });
});
