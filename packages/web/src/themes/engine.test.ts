import { describe, expect, it } from 'vitest';
import { argbFromHex, hexFromArgb } from '@material/material-color-utilities';
import { CUSTOM_START, STARTERS, generate, generatedSpec, hctOf, minRatios, withHue, type ThemeSpec } from './engine';
import { auroraHolds, coreShows } from '../adaptive/aurora';

/** The theme's equalizer glow inside its bar keeps the bar's inks at their rules at the glow's peak. */
function glowHoldsIn(spec: ThemeSpec, dark: boolean): boolean {
  const t = generate(spec, dark).tokens;
  const a = (k: string) => argbFromHex(t[k]!);
  const veils = [1, 2, 3].map((i) => a(`--aur-veil-${i}`)), cores = [1, 2, 3].map((i) => a(`--aur-core-${i}`));
  return auroraHolds(a('--th-bar'), veils, cores, { texts: [a('--th-bar-ink'), a('--th-bar-ink-2')], marks: [a('--th-bar-accent')] })
    // and its brightest core stands apart from the bar: apparent at a glance
    && Math.max(...cores.map((c) => coreShows(c, a('--th-bar')))) >= 1.35;
}

/** a seeded random, so a failure names a seed that can be replayed */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

describe('theme engine', () => {
  it('every starter holds every pair in light and dark', () => {
    for (const [id, spec] of Object.entries(STARTERS)) {
      for (const dark of [false, true]) {
        expect(glowHoldsIn(spec, dark), `${id} ${dark ? 'dark' : 'light'}: the bar's inks over the glow`).toBe(true);
        for (const p of generate(spec, dark).pairs) expect(p.ratio, `${id} ${dark ? 'dark' : 'light'} ${p.name}`).toBeGreaterThanOrEqual(p.min);
      }
    }
  });

  it('any custom seed, with or without a second accent, holds every pair', () => {
    const r = rng(52);
    for (let i = 0; i < 400; i++) {
      const hex = () => hexFromArgb((0xff000000 | Math.floor(r() * 0xffffff)) >>> 0);
      const spec: ThemeSpec = { seed: hex(), accent2: i % 2 ? hex() : null, mono: i % 7 === 0 };
      for (const dark of [false, true]) {
        expect(glowHoldsIn(spec, dark), `${JSON.stringify(spec)} ${dark ? 'dark' : 'light'}: the bar's inks over the glow`).toBe(true);
        for (const p of generate(spec, dark).pairs) expect(p.ratio, `${JSON.stringify(spec)} ${dark ? 'dark' : 'light'} ${p.name}`).toBeGreaterThanOrEqual(p.min);
      }
    }
  }, 30_000); // hundreds of seeds: CI runners are slower than a laptop

  it('reports the lowest ratios', () => {
    const m = minRatios(STARTERS.moody, true);
    expect(m.text).toBeGreaterThanOrEqual(4.5);
    expect(m.nonText).toBeGreaterThanOrEqual(3);
  });

  it('Adaptive and Classic keep the brand tokens; the others generate', () => {
    expect(generatedSpec({ theme: 'adaptive', custom: null })).toBeNull();
    expect(generatedSpec({ theme: 'classic', custom: { seed: '#ff0000' } })).toBeNull();
    expect(generatedSpec({ theme: 'moody', custom: null })).toEqual(STARTERS.moody);
    expect(generatedSpec({ theme: 'custom', custom: null })).toEqual(CUSTOM_START);
    expect(generatedSpec({ theme: 'custom', custom: { seed: '#ff0000' } })).toEqual({ seed: '#ff0000' });
  });

  it('keeps the logo on the brand teal in every theme', () => {
    expect(generate(STARTERS.moody, false).tokens['--logo-dew']).toBe('#276a82');
    expect(generate(STARTERS.mono, true).tokens['--logo-dew']).toBe('#5fb0cc');
  });

  it('writes the bar to its own names, never the adaptive ones', () => {
    const keys = Object.keys(generate(STARTERS.moody, true).tokens);
    expect(keys.filter((k) => k.startsWith('--ad-'))).toEqual([]);
    expect(keys).toContain('--th-bar');
  });

  it('moves a colour round the hue wheel, keeping it a colour', () => {
    const grey = '#808080';
    const moved = hctOf(withHue(grey, 200));
    expect(Math.abs(moved.hue - 200)).toBeLessThan(3);
    expect(moved.chroma).toBeGreaterThan(20);
  });
});
