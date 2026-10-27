/**
 * The aurora at the foot of the window: the brand bar (glass over the
 * canvas, tokens.css) keeps its text and keys over every part of the brand
 * aurora; the CSS keeps the bright cores under the text, as aurora.ts
 * assumes; the motion is calm. (Adaptive covers: scheme.test.ts; themes:
 * engine.test.ts.)
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { auroraHolds, auroraHues, coreShows } from './aurora';
import { CURTAINS, curtainOf, step, type AuroraState } from '../components/glowDriver';

const tokens = readFileSync(new URL('../styles/tokens.css', import.meta.url), 'utf8');
const css = readFileSync(new URL('../components/BarGlow.module.css', import.meta.url), 'utf8');

const argb = (h: string) => (0xff000000 | parseInt(h.slice(1), 16)) >>> 0;
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
    it(`${name}: title and second line 4.5:1, keys 3:1 over the aurora; its cores stand apart`, () => {
      const bar = glassOver(theme);
      const veils = [1, 2, 3].map((i) => argb(theme.get(`aur-veil-${i}`)!)), cores = [1, 2, 3].map((i) => argb(theme.get(`aur-core-${i}`)!));
      expect(auroraHolds(bar, veils, cores, { texts: [argb(theme.get('ink')!), argb(theme.get('ink-2')!)], marks: [argb(theme.get('dew')!)] })).toBe(true);
      expect(Math.max(...cores.map((c) => coreShows(c, bar)))).toBeGreaterThanOrEqual(2.4);
    });
  }
});

describe('the curtains', () => {
  it('keep the bright cores under the text (gone by 13 % of the strip; the second line starts at 23 %)', () => {
    expect(css).toMatch(/\.core \{[^}]*linear-gradient\(to top, black, black 5%, transparent 13%\)/);
    expect(css).toMatch(/var\(--aur-veil-1\) 75%/);
    expect(css).toMatch(/var\(--aur-core-1\) 85%/);
    expect(css).toMatch(/filter: blur\(3px\)/);
  });

  it('are three hues apart, even from a one-hue cover', () => {
    const [a, b, c] = auroraHues(200, 205);
    const gap = (x: number, y: number) => Math.abs(((y - x + 540) % 360) - 180);
    expect(gap(a!, b!)).toBeGreaterThanOrEqual(30);
    expect(gap(a!, c!)).toBeGreaterThanOrEqual(30);
  });

  it('breathe with the music, never jump: a beat moves the level a little each frame', () => {
    let s: AuroraState = { phase: [0, 0.3, 0.6], lean: [0, 0, 0], level: 0.2 };
    const next = step(s, [1, 1, 1], 1 / 30, 0);
    expect(next.level - s.level).toBeLessThan(0.05);
    for (let i = 0; i < 90; i++) s = step(s, [1, 1, 1], 1 / 30, i / 30);
    expect(s.level).toBeGreaterThan(0.85);
    // and falls more slowly than it rises
    const down = step(s, [0, 0, 0], 1 / 30, 3);
    expect(s.level - down.level).toBeLessThan(next.level - 0.2);
  });

  it('drift slowly, each at its own pace, faster when loud', () => {
    const quiet = step({ phase: [0, 0, 0], lean: [0, 0, 0], level: 0 }, [0, 0, 0], 1, 0);
    const loud = step({ phase: [0, 0, 0], lean: [0, 0, 0], level: 1 }, [1, 1, 1], 1, 0);
    for (let i = 0; i < CURTAINS.length; i++) {
      const q = Math.min(quiet.phase[i]!, 1 - quiet.phase[i]!);
      expect(q).toBeLessThan(0.02); // under 2 % of the window a second
      expect(Math.min(loud.phase[i]!, 1 - loud.phase[i]!)).toBeGreaterThan(q);
    }
    expect(curtainOf(1, 1).height).toBe(1);
    expect(curtainOf(1, 0).height).toBe(0.5);
  });
});
