import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CoverArt, coverHue } from '../components/ui/CoverArt';

const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '');
const read = (rel: string) => stripComments(readFileSync(new URL(rel, import.meta.url), 'utf8'));

describe('cover placeholder: a hue of its own, from the title', () => {
  it('is deterministic and in range', () => {
    for (const title of ['The Drift', 'Road Salt One (Limited Edition)', 'Z103.5 Summer Rush 2008', '', 'ﺪﻟÊ ﺎﻬﻨﻴﺋèé']) {
      const h = coverHue(title);
      expect(h).toBe(coverHue(title));
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(360);
    }
  });

  it('the same title in either Unicode normalisation gets the same hue', () => {
    expect(coverHue('Pokémon')).toBe(coverHue('Pokémon'));
  });

  it('neighbouring titles land on clearly different hues', () => {
    const a = coverHue('Skull Bundle Vol. 1');
    const b = coverHue('Skull Bundle Vol. 2');
    const d = Math.abs(a - b);
    expect(Math.min(d, 360 - d)).toBeGreaterThan(10);
    // and a shelf of titles spreads round the wheel instead of clumping
    const hues = new Set(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'].map((t) => Math.floor(coverHue(`Album ${t}`) / 60)));
    expect(hues.size).toBeGreaterThanOrEqual(4);
  });

  it('renders the hue as a custom property; rings drawn in close; large initials', () => {
    const html = renderToStaticMarkup(<CoverArt title="The Drift" />);
    expect(html).toContain(`--cover-hue:${coverHue('The Drift')}`);
    const radii = [...html.matchAll(/r="(\d+)"/g)].map((m) => Number(m[1]));
    expect(radii).toEqual([40, 32, 24]);
    expect(html).toMatch(/>D<\/span>/);
    const css = read('../components/ui/CoverArt.module.css');
    expect(css).toMatch(/\.initials \{[^}]*font-size: 26cqi/);
    // the hue only tints theme tokens, so both themes keep their own field
    expect(css).toMatch(/--cover-tint: oklch\(0\.72 0\.09 var\(--cover-hue, 210\)\)/);
    expect(css).toMatch(/color-mix\(in oklch, var\(--cover-tint\) 26%, var\(--dew-tint\)\)/);
  });
});

describe('cover hover: smooth, inside the clipped square', () => {
  const css = read('../components/ui/CoverArt.module.css');

  it('only interactive covers react; the art scales by transform on its own layer, 250ms ease-out', () => {
    expect(renderToStaticMarkup(<CoverArt title="x" interactive />)).toMatch(/class="[^"]*interactive/);
    expect(renderToStaticMarkup(<CoverArt title="x" />)).not.toMatch(/interactive/);
    expect(css).toMatch(/\.interactive \.art \{[^}]*will-change: transform;[^}]*transition: transform 250ms var\(--ease-out\)/);
    expect(css).toMatch(/:hover > \.interactive \.art,\s*\.interactive:hover \.art \{\s*transform: translateZ\(0\) scale\(1\.04\)/);
  });

  it('the shadow deepens; the hairline sits above the art so it never jumps', () => {
    expect(css).toMatch(/\.interactive \{[^}]*transition: box-shadow 250ms var\(--ease-out\)/);
    expect(css).toMatch(/\.interactive::after \{[^}]*z-index: 1;[^}]*box-shadow: inset 0 0 0 1px/);
  });

  it('reduced motion: no zoom', () => {
    expect(css).toMatch(/prefers-reduced-motion: reduce\)[\s\S]*:hover > \.interactive \.art,\s*\.interactive:hover \.art \{\s*transform: translateZ\(0\);/);
  });

  it('Home uses it and no longer scales the bare img', () => {
    const tsx = readFileSync(new URL('./DashboardPage.tsx', import.meta.url), 'utf8');
    expect(tsx).toMatch(/<CoverArt [^>]*interactive \/>/);
    expect(read('./DashboardPage.module.css')).not.toMatch(/\.album:hover img/);
  });
});

describe('Home: a kiosk view on a desktop', () => {
  const css = read('./DashboardPage.module.css');
  const tsx = readFileSync(new URL('./DashboardPage.tsx', import.meta.url), 'utf8');

  it('the page is exactly the pane height on a desktop window, natural scroll otherwise', () => {
    expect(tsx).toMatch(/data-kiosk-page/);
    expect(read('../components/Layout.module.css')).toMatch(/@media \(min-width: 901px\) and \(min-height: 640px\) \{ \.page:has\(\[data-kiosk-page\]\), \.page:has\(\[data-kiosk-page\]\) > div \{ height: 100%; \} \}/);
    expect(css).toMatch(/@media \(min-width: 901px\) and \(min-height: 640px\) \{/);
  });

  it('the recently added row takes the room left and sizes covers to both its width and height', () => {
    expect(css).toMatch(/\.stage \{[^}]*flex: 1;[^}]*container: stage \/ size;/);
    expect(css).toMatch(/--tile: max\(6rem, min\(\(100cqi - \(var\(--cols\) - 1\) \* var\(--gap\)\) \/ var\(--cols\), 100cqb - var\(--meta\)\)\)/);
    expect(css).toMatch(/grid-template-columns: repeat\(var\(--cols\), var\(--tile\)\)/);
  });

  it('a narrow row shows fewer, larger covers instead of tiny ones', () => {
    expect(css).toMatch(/@container stage \(max-width: 760px\) \{[^}]*--cols: 4;[^}]*\}\s*\.album:nth-child\(n \+ 5\) \{ display: none; \}/);
    expect(css).toMatch(/@container stage \(max-width: 480px\) \{[^}]*--cols: 3;[^}]*\}\s*\.album:nth-child\(n \+ 4\) \{ display: none; \}/);
  });
});

describe('titles in another script (or mis-decoded tags) keep their own direction', () => {
  it('Home and the album lists render titles and artists with dir="auto"', () => {
    const home = readFileSync(new URL('./DashboardPage.tsx', import.meta.url), 'utf8');
    expect(home).toMatch(/<h3 dir="auto"[^>]*>\{album\.title\}<\/h3><p dir="auto">\{album\.artistCredit\}<\/p>/);
    const albums = readFileSync(new URL('./AlbumsPage.tsx', import.meta.url), 'utf8');
    expect(albums).toMatch(/className=\{styles\.albumTitle\} dir="auto">\{album\.title\}/);
    expect(albums).toMatch(/className=\{styles\.listTitle\} dir="auto">\{album\.title\}/);
  });
});
