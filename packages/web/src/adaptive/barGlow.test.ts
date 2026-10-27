/**
 * The equalizer glow inside the player bar: the brand bar (glass over the
 * canvas, tokens.css) keeps its inks over the brand glow, the CSS draws the
 * lobes no stronger than the peak the contrast is held at, and the lobes
 * follow the bands (adaptive covers: scheme.test.ts; themes: engine.test.ts).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BAR_GLOW_PEAK, glowHolds } from './barGlow';
import { LOBES, lobeLevel, lobeStyle } from '../components/BarGlow';

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
    it(`${name}: title and second line 4.5:1, seek fill and keys 3:1 over the glow at its peak`, () => {
      expect(glowHolds(argb(theme.get('seek-glow')!), glassOver(theme), {
        texts: [argb(theme.get('ink')!), argb(theme.get('ink-2')!)],
        marks: [argb(theme.get('dew')!)],
      })).toBe(true);
    });
  }
});

describe('the lobes', () => {
  it('are drawn no stronger than the peak the contrast holds at', () => {
    const strengths = [...glowCss.matchAll(/var\(--seek-glow\) (\d+)%/g)].map((m) => Number(m[1]));
    expect(strengths.length).toBeGreaterThan(0);
    expect(Math.max(...strengths)).toBe(Math.round(BAR_GLOW_PEAK * 100));
  });

  it('a loud peak reaches half the bar, quiet music a low line', () => {
    expect(glowCss).toMatch(/\.lobe \{[^}]*height: 50%/);
    expect(lobeStyle(1).transform).toBe('scaleY(1.000)');
    expect(Number(lobeStyle(0).transform.match(/[\d.]+/)![0])).toBeLessThan(0.2);
    expect(lobeStyle(2)).toEqual(lobeStyle(1));
  });

  it('the lows in the middle, the highs at the ends', () => {
    const bands = [0.9, 0.4, 0.1];
    const mid = (LOBES - 1) / 2;
    expect(lobeLevel(mid, bands)).toBeCloseTo(0.9);
    expect(lobeLevel(0, bands)).toBeCloseTo(0.1);
    expect(lobeLevel(LOBES - 1, bands)).toBeCloseTo(0.1);
    expect(lobeLevel(mid - 1, bands)).toBeGreaterThan(lobeLevel(mid - 2, bands));
  });
});
