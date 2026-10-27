/**
 * The equalizer glow at the foot of the window: the brand bar (glass over
 * the canvas, tokens.css) keeps its text and keys over the brand glow and
 * the glow stands apart from it; the CSS draws the columns exactly as
 * strong as the profile the contrast is held at; the columns follow the
 * levels under the width's envelope. (Adaptive covers: scheme.test.ts;
 * themes: engine.test.ts.)
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GLOW_PEAK, GLOW_SHOWS, MARK_ALPHA, PROFILE, TEXT_ALPHA, alphaAt, glowHolds, glowShows } from './barGlow';
import { COLUMN, PITCH, columnScale, columnsOf } from '../components/BarGlow';
import { SPAN, compress, envelope, spread } from '../components/glowDriver';

const tokens = readFileSync(new URL('../styles/tokens.css', import.meta.url), 'utf8');
const glowCss = readFileSync(new URL('../components/BarGlow.module.css', import.meta.url), 'utf8');

const argb = (h: string) => (0xff000000 | parseInt(h.slice(1), 16)) >>> 0;
/** a block's declarations: the light :root, then the explicit dark theme */
function decl(selector: string): Map<string, string> {
  const start = tokens.indexOf(selector);
  const body = tokens.slice(tokens.indexOf('{', start) + 1, tokens.indexOf('}', start));
  return new Map([...body.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
}
const light = decl(':root {');
const dark = new Map([...light, ...decl(':root[data-theme="dark"] {')]);

/** The glass bar over the canvas, as the browser paints it. */
function glassOver(theme: Map<string, string>): number {
  const [r, g, b, a] = theme.get('glass')!.match(/[\d.]+/g)!.map(Number) as [number, number, number, number];
  const c = argb(theme.get('canvas')!);
  const ch = (v: number, shift: number) => Math.round(v * a + ((c >> shift) & 255) * (1 - a));
  return ((0xff << 24) | (ch(r, 16) << 16) | (ch(g, 8) << 8) | ch(b, 0)) >>> 0;
}

describe('the brand bar (glass over the canvas)', () => {
  for (const [name, theme] of [['light', light], ['dark', dark]] as const) {
    it(`${name}: title and second line 4.5:1, keys 3:1 over the glow; the glow stands ${GLOW_SHOWS}:1 apart`, () => {
      const glow = argb(theme.get('seek-glow')!), bar = glassOver(theme);
      expect(glowHolds(glow, bar, { texts: [argb(theme.get('ink')!), argb(theme.get('ink-2')!)], marks: [argb(theme.get('dew')!)] })).toBe(true);
      expect(glowShows(glow, bar)).toBeGreaterThanOrEqual(GLOW_SHOWS);
    });
  }
});

describe('the columns', () => {
  it('are drawn as strong as the profile the contrast is held at', () => {
    const stops = [...glowCss.matchAll(/var\(--seek-glow\) ([\d.]+)%, transparent\)(?: (\d+)%)?/g)].map((m) => [m[2] === undefined ? 0 : Number(m[2]) / 100, Number(m[1]) / 100]);
    const profile = PROFILE.filter(([, s]) => s > 0).map(([at, s]) => [at, Math.round(GLOW_PEAK * s * 1000) / 1000]);
    expect(stops).toEqual(profile);
    expect(glowCss).toMatch(/\.column \{[^}]*width: 10px;[^}]*height: 50%;/);
    expect(COLUMN).toBe(10);
  });

  it('give the text and the keys a fraction of the peak', () => {
    expect(alphaAt(0)).toBe(GLOW_PEAK);
    expect(alphaAt(1)).toBeCloseTo(0);
    expect(TEXT_ALPHA).toBeLessThan(GLOW_PEAK * 0.15);
    expect(MARK_ALPHA).toBeLessThan(TEXT_ALPHA);
  });

  it('sit on one grid across the window, so the account row and the bar carry on', () => {
    const row = columnsOf(0, 248, 1440), bar = columnsOf(248, 1440, 1440);
    const centres = [...row.map((c) => c.left + COLUMN / 2), ...bar.map((c) => c.left + 248 + COLUMN / 2)];
    // a column on the seam is in both pieces, each drawing its own side
    const unique = [...new Set(centres)].sort((a, b) => a - b);
    expect(unique.every((x, i) => i === 0 || x - unique[i - 1]! === PITCH)).toBe(true);
    expect(unique[0]).toBe(PITCH / 2);
  });

  it('are fullest in the middle, short and faint towards both edges', () => {
    expect(envelope(0.5)).toBeCloseTo(1);
    expect(envelope(0)).toBeCloseTo(0.15);
    expect(envelope(1)).toBeCloseTo(0.15);
    expect(envelope(0.25)).toBeGreaterThan(envelope(0.05));
    expect(columnScale(1, 1)).toBe(1);
    expect(columnScale(0.5, 1)).toBe(0.5);
    expect(columnScale(1, 0)).toBeGreaterThan(0.1);
  });

  it('even out in the middle: one loud band does not spike there', () => {
    const lows = spread([1, 0.2, 0.2], 0), even = spread([0.47, 0.47, 0.47], 0);
    const mid = Math.floor(SPAN / 2);
    expect(lows[mid]!).toBeLessThan(0.8);
    expect(Math.abs(lows[mid]! - even[mid]!)).toBeLessThan(0.35);
    // compressed: a quiet band still lifts, a loud one never pins
    expect(compress(0)).toBeGreaterThan(0.1);
    expect(compress(1)).toBeLessThan(1);
  });
});
