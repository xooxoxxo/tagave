/**
 * The equalizer glow's motion and layout (glowDriver.ts): a quick attack and
 * a slower release per band, a peak that holds then falls, the line on the
 * loudness, and columns mirrored about the bar's right side (a desktop) or
 * its middle (a phone), never past the bar's edges.
 */
import { describe, expect, it } from 'vitest';
import { BANDS } from '../adaptive/levels';
import { ANCHOR, HOLD, MIN_PITCH, clearOf, emptySpectrum, gainAt, heldSpectrum, layoutColumns, loudnessOf, stepSpectrum, stillSpectrum } from './glowDriver';

const FRAME = 1 / 30;
const run = (raw: number[], seconds: number, s = emptySpectrum()) => {
  for (let t = 0; t < seconds - 1e-9; t += FRAME) stepSpectrum(s, raw, FRAME);
  return s;
};

describe('envelopes', () => {
  it('a band rises within about 60 ms and falls over about 300', () => {
    const full = new Array<number>(BANDS).fill(1), none = new Array<number>(BANDS).fill(0);
    const s = run(full, 2 * FRAME);
    expect(s.level[0]).toBeGreaterThan(0.9);
    run(none, 0.1, s);
    expect(s.level[0]).toBeGreaterThan(0.4);
    run(none, 0.2, s);
    expect(s.level[0]).toBeLessThan(0.15);
  });

  it('a peak holds, then falls, never below its band', () => {
    const s = run(new Array<number>(BANDS).fill(1), 0.2);
    run(new Array<number>(BANDS).fill(0), HOLD - 0.05, s);
    expect(s.peak[3]).toBeCloseTo(1, 2);
    run(new Array<number>(BANDS).fill(0), 0.3, s);
    expect(s.peak[3]).toBeLessThan(0.9);
    expect(s.peak[3]).toBeGreaterThanOrEqual(s.level[3]!);
  });

  it('the line follows the loudness, bass first', () => {
    const low = Array.from({ length: BANDS }, (_, i) => (i < BANDS / 2 ? 0.6 : 0));
    const high = Array.from({ length: BANDS }, (_, i) => (i < BANDS / 2 ? 0 : 0.6));
    expect(loudnessOf(low)).toBeGreaterThan(loudnessOf(high));
    expect(loudnessOf(new Array<number>(BANDS).fill(0))).toBe(0);
    expect(run(low, 0.5).loud).toBeCloseTo(loudnessOf(low), 2);
  });

  it('the still glow is gentle and fuller in the bass; a held one keeps its levels', () => {
    const still = stillSpectrum();
    expect(Math.max(...still.level)).toBeLessThan(0.5);
    expect(still.level[0]).toBeGreaterThan(still.level[BANDS - 1]!);
    expect(heldSpectrum([0.3, 0.8]).level[1]).toBeCloseTo(0.8);
  });
});

describe('layout', () => {
  it('a desktop bar: mirrored about its right side, every band to the left, cut by the right edge', () => {
    const width = 1200;
    const { centre, pitch, columns } = layoutColumns(width, 'right');
    expect(centre).toBeCloseTo(width * ANCHOR.right);
    const left = columns.filter((c) => c.x < centre), right = columns.filter((c) => c.x > centre);
    expect(new Set(left.map((c) => c.band)).size).toBe(BANDS - 1);
    expect(columns.every((c) => c.span === 1)).toBe(true);
    expect(right.length).toBeLessThan(left.length);
    expect(right.length).toBeGreaterThan(5);
    for (const c of columns) {
      expect(c.x).toBeGreaterThanOrEqual(-pitch / 2);
      expect(c.x).toBeLessThanOrEqual(width + pitch / 2);
    }
    // the bass at the mirror point, the light falling off away from it
    expect(columns.find((c) => c.band === 0)!.x).toBeCloseTo(centre);
    expect(gainAt(0)).toBe(1);
    expect(gainAt(BANDS - 1)).toBeCloseTo(0.25);
  });

  it('a phone: across the mini bar, the same both ways, two bands a column so a column stays wide enough', () => {
    const { columns, pitch } = layoutColumns(384, 'centre');
    const left = columns.filter((c) => c.x < 192), right = columns.filter((c) => c.x > 192);
    expect(left.length).toBe(right.length);
    expect(pitch).toBeGreaterThanOrEqual(MIN_PITCH);
    expect(columns.every((c) => c.span === 2)).toBe(true);
    // every band still shows somewhere
    expect(new Set(left.flatMap((c) => [c.band, c.band + 1])).size).toBe(BANDS - 2);
  });

  it('no width, no columns', () => {
    expect(layoutColumns(0, 'right').columns).toEqual([]);
  });

  it('a colour at no alpha, for the columns\' fade', () => {
    expect(clearOf('rgb(95, 176, 204)')).toBe('rgba(95,176,204,0)');
    expect(clearOf('rgba(1, 2, 3, 0.5)')).toBe('rgba(1,2,3,0)');
    expect(clearOf('oklch(0.5 0.1 200)')).toBe('transparent');
  });
});
