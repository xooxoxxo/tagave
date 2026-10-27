import { describe, expect, it } from 'vitest';
import { Hct, argbFromHex } from '@material/material-color-utilities';
import { adaptiveTokens, sourceColour } from './scheme';
import { THEME_INKS, WASH_MAX, argbOfHex, extremes, saturate, washOpacity, type Extremes } from './wash';
import { BRAND_TOKENS } from './brand';

type RGB = [number, number, number];
const parse = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const lin = (v: number) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const lum = ([r, g, b]: RGB) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const ratio = (a: RGB, b: RGB) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
/** what a CSS transition between two hex colours paints at t (legacy colours interpolate in sRGB) */
const mix = (a: RGB, b: RGB, t: number): RGB => [0, 1, 2].map((i) => Math.round(a[i]! + (b[i]! - a[i]!) * t)) as RGB;

/** Theme inks the adaptive tokens leave alone (tokens.css). */
const INK = { light: { ink2: '#46525e', ink3: '#5e6975' }, dark: { ink2: '#a9b5c0', ink3: '#8795a2' } };

/** [name, foreground token, background token, minimum] */
const PAIRS: [string, string, string, number][] = [
  ['label on accent', '--ad-accent-ink', '--ad-accent', 4.5],
  ['accent text on canvas', '--ad-accent', '--ad-canvas', 4.5],
  ['selected label on tint', '--ad-chip', '--ad-tint', 4.5],
  ['bar title on bar', '--ad-bar-ink', '--ad-bar', 4.5],
  ['bar second line on bar', '--ad-bar-ink-2', '--ad-bar', 4.5],
  ['seek fill on bar', '--ad-bar-accent', '--ad-bar', 3],
  ['problem said on the mini bar', '--ad-bar-danger', '--ad-bar', 4.5],
];

const rgbOfArgb = (argb: number): RGB => [(argb >> 16) & 255, (argb >> 8) & 255, argb & 255];
const overRgb = (top: RGB, a: number, bottom: RGB): RGB => [0, 1, 2].map((i) => Math.round(top[i]! * a + bottom[i]! * (1 - a))) as RGB;

function check(tokens: Record<string, string>, theme: 'light' | 'dark', label: string, colours?: Extremes) {
  for (const [name, fg, bg, min] of PAIRS) {
    expect(ratio(parse(tokens[fg]!), parse(tokens[bg]!)), `${label} ${theme}: ${name}`).toBeGreaterThanOrEqual(min);
  }
  expect(ratio(parse(INK[theme].ink3), parse(tokens['--ad-canvas']!)), `${label} ${theme}: ink-3 on canvas`).toBeGreaterThanOrEqual(4.5);
  // the seek fill still reads where the glow lies under it (its line at most 0.55 x 0.9 strong)
  const bar = parse(tokens['--ad-bar']!), glow = parse(tokens['--ad-glow']!);
  const lit = [0, 1, 2].map((i) => Math.round(glow[i]! * 0.5 + bar[i]! * 0.5)) as RGB;
  expect(ratio(parse(tokens['--ad-bar-accent']!), lit), `${label} ${theme}: seek fill on the glow`).toBeGreaterThanOrEqual(3);
  // the same on Now Playing's seek bar, which lies on the canvas
  const canvas = parse(tokens['--ad-canvas']!);
  expect(ratio(parse(tokens['--ad-accent']!), overRgb(glow, 0.5, canvas)), `${label} ${theme}: seek fill on the glow, on the canvas`).toBeGreaterThanOrEqual(3);
  // the bar is a clear step from the page it sits on
  expect(ratio(parse(tokens['--ad-bar']!), canvas), `${label} ${theme}: bar vs canvas`).toBeGreaterThanOrEqual(1.4);
  // Now Playing: the blurred cover over the cover's canvas, at its darkest and lightest pixel
  if (colours) {
    const a = washOpacity(argbOfHex(tokens['--ad-canvas']!), argbOfHex(tokens['--ad-accent']!), colours, theme === 'dark', WASH_MAX.adaptive);
    for (const px of [colours.darkest, colours.lightest]) {
      const bg = overRgb(rgbOfArgb(saturate(px)), a, canvas);
      for (const ink of THEME_INKS[theme]) expect(ratio(rgbOfArgb(ink), bg), `${label} ${theme}: ink on Now Playing's cover wash at ${a}`).toBeGreaterThanOrEqual(4.5);
      expect(ratio(parse(tokens['--ad-accent']!), bg), `${label} ${theme}: accent on Now Playing's cover wash`).toBeGreaterThanOrEqual(3);
    }
  }
}

function pixels(parts: [string, number][]): Uint8ClampedArray {
  const out: number[] = [];
  for (const [c, share] of parts) { const [r, g, b] = parse(c); for (let i = 0; i < share * 2000; i++) out.push(r, g, b, 255); }
  return Uint8ClampedArray.from(out);
}

const FIXTURES: Record<string, [string, number][]> = {
  moody: [['#141826', 0.55], ['#2a1f3d', 0.3], ['#c98a3a', 0.05], ['#3b3355', 0.1]],
  bright: [['#ffd400', 0.5], ['#ff2d8a', 0.3], ['#00c2ff', 0.2]],
  mono: [['#d9d6d0', 0.6], ['#2b2b2b', 0.25], ['#8a8a8a', 0.15]],
  pastel: [['#f7d6c8', 0.55], ['#c8ead9', 0.25], ['#d9cdf2', 0.2]],
  redblack: [['#0a0a0a', 0.6], ['#e10600', 0.3], ['#f5f5f5', 0.1]],
};

let seed = 11;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const randomHex = () => `#${[0, 0, 0].map(() => Math.floor(rnd() * 256).toString(16).padStart(2, '0')).join('')}`;

describe('sourceColour', () => {
  it('a colourless cover has none (the brand teal stays)', () => {
    expect(sourceColour(pixels(FIXTURES['mono']!))).toBeNull();
    expect(sourceColour(pixels([['#ffffff', 1]]))).toBeNull();
  });
  it('a coloured cover has one', () => {
    for (const k of ['moody', 'bright', 'pastel', 'redblack']) expect(sourceColour(pixels(FIXTURES[k]!)), k).not.toBeNull();
  });
});

describe('adaptiveTokens: the accent is a colour', () => {
  it('a dark, dull cover still gives a coloured accent at the role tone, not near-black', () => {
    const src = sourceColour(pixels(FIXTURES['moody']!))!;
    for (const dark of [false, true]) {
      const accent = Hct.fromInt(argbFromHex(adaptiveTokens(src, dark)['--ad-accent']!));
      expect(accent.chroma).toBeGreaterThan(25);
      expect(Math.abs(accent.tone - (dark ? 80 : 40))).toBeLessThan(1.5);
    }
  });
});

describe('adaptiveTokens: AA whatever the cover', () => {
  for (const [name, parts] of Object.entries(FIXTURES)) {
    it(name, () => {
      const px = pixels(parts), src = sourceColour(px);
      if (src === null) return;
      for (const theme of ['light', 'dark'] as const) check(adaptiveTokens(src, theme === 'dark'), theme, name, extremes(px));
    });
  }
  it('300 random three-colour covers', () => {
    let coloured = 0;
    for (let i = 0; i < 300; i++) {
      const px = pixels([[randomHex(), 0.6], [randomHex(), 0.3], [randomHex(), 0.1]]), src = sourceColour(px);
      if (src === null) continue;
      coloured++;
      for (const theme of ['light', 'dark'] as const) check(adaptiveTokens(src, theme === 'dark'), theme, `cover ${i}`, extremes(px));
    }
    expect(coloured).toBeGreaterThan(200);
  }, 30_000); // hundreds of covers: CI runners are slower than a laptop
  it('the brand values pass the same pairs (the fade back to brand)', () => {
    for (const theme of ['light', 'dark'] as const) {
      for (const [name, fg, bg, min] of PAIRS) {
        if (fg.startsWith('--ad-bar') || bg === '--ad-bar') continue; // the brand bar is glass, measured in tokenContrast.test.ts
        expect(ratio(parse(BRAND_TOKENS[theme][fg]!), parse(BRAND_TOKENS[theme][bg]!)), `${theme} ${name}`).toBeGreaterThanOrEqual(min);
      }
    }
  });
});

describe('Now Playing\'s cover wash with adaptive colours off, or a colourless cover (the brand canvas)', () => {
  it('300 random covers and the fixtures: every ink 4.5:1 and the accent 3:1 on the darkest and lightest pixel', () => {
    const covers = [...Object.values(FIXTURES).map((f) => pixels(f)), pixels([['#ffffff', 0.5], ['#000000', 0.5]])];
    for (let i = 0; i < 300; i++) covers.push(pixels([[randomHex(), 0.6], [randomHex(), 0.3], [randomHex(), 0.1]]));
    let shown = 0;
    for (const px of covers) {
      const e = extremes(px);
      for (const theme of ['light', 'dark'] as const) {
        const brand = BRAND_TOKENS[theme];
        const canvas = parse(brand['--ad-canvas']!);
        const a = washOpacity(argbOfHex(brand['--ad-canvas']!), argbOfHex(brand['--ad-accent']!), e, theme === 'dark', WASH_MAX.brand);
        expect(a).toBeLessThanOrEqual(0.3);
        if (a > 0) shown++;
        for (const p of [e.darkest, e.lightest]) {
          const bg = overRgb(rgbOfArgb(saturate(p)), a, canvas);
          for (const ink of THEME_INKS[theme]) expect(ratio(rgbOfArgb(ink), bg)).toBeGreaterThanOrEqual(4.5);
          expect(ratio(parse(brand['--ad-accent']!), bg)).toBeGreaterThanOrEqual(3);
        }
      }
    }
    // the cover still shows on most covers
    expect(shown).toBeGreaterThan(covers.length);
  }, 30_000); // hundreds of covers: CI runners are slower than a laptop
});

describe('the 600 ms cross-fade never dips below the minimum', () => {
  it('between 200 random pairs of covers, and from and to the brand', () => {
    const schemes: Record<'light' | 'dark', Record<string, string>[]> = { light: [BRAND_TOKENS.light], dark: [BRAND_TOKENS.dark] };
    while (schemes.light.length < 41) {
      const src = sourceColour(pixels([[randomHex(), 0.6], [randomHex(), 0.4]]));
      if (src === null) continue;
      schemes.light.push(adaptiveTokens(src, false));
      schemes.dark.push(adaptiveTokens(src, true));
    }
    let worst = Infinity;
    for (const theme of ['light', 'dark'] as const) {
      const list = schemes[theme];
      for (let i = 0; i < list.length; i++) for (let j = 0; j < 5; j++) {
        const a = list[i]!, b = list[(i + j + 1) % list.length]!;
        for (const [name, fg, bg, min] of PAIRS) {
          if ((a === schemes[theme][0] || b === schemes[theme][0]) && (fg.startsWith('--ad-bar') || bg === '--ad-bar')) continue;
          for (let t = 0; t <= 1; t += 0.1) {
            const r = ratio(mix(parse(a[fg]!), parse(b[fg]!), t), mix(parse(a[bg]!), parse(b[bg]!), t));
            worst = Math.min(worst, r / min);
            expect(r, `${theme} ${name} at t=${t.toFixed(1)}`).toBeGreaterThanOrEqual(min);
          }
        }
      }
    }
    expect(worst).toBeGreaterThanOrEqual(1);
  }, 30_000); // hundreds of covers: CI runners are slower than a laptop
});
