/**
 * The equalizer glow's motion and shape (glowDriver.ts): a quick attack and
 * a slower release per band, the line on the loudness, and one smooth wash
 * of light mirrored about the bar's right side (a desktop) or its middle (a
 * phone): no band stands alone as a bar, and the light drifts while it plays.
 */
import { describe, expect, it } from 'vitest';
import { BANDS } from '../adaptive/levels';
import { ANCHOR, MIN_SIGMA, clearOf, emptySpectrum, gainAt, heightAt, heldSpectrum, layoutGlow, loudnessOf, stepSpectrum, stillSpectrum } from './glowDriver';

const FRAME = 1 / 30;
const run = (raw: number[], seconds: number, s = emptySpectrum()) => {
  for (let t = 0; t < seconds - 1e-9; t += FRAME) stepSpectrum(s, raw, FRAME);
  return s;
};

describe('envelopes', () => {
  it('a band rises within about 100 ms and falls over about 500', () => {
    const full = new Array<number>(BANDS).fill(1), none = new Array<number>(BANDS).fill(0);
    const s = run(full, 4 * FRAME);
    expect(s.level[0]).toBeGreaterThan(0.9);
    run(none, 0.1, s);
    expect(s.level[0]).toBeGreaterThan(0.5);
    run(none, 0.5, s);
    expect(s.level[0]).toBeLessThan(0.15);
  });

  it('the line follows the loudness, bass first', () => {
    const low = Array.from({ length: BANDS }, (_, i) => (i < BANDS / 2 ? 0.6 : 0));
    const high = Array.from({ length: BANDS }, (_, i) => (i < BANDS / 2 ? 0 : 0.6));
    expect(loudnessOf(low)).toBeGreaterThan(loudnessOf(high));
    expect(loudnessOf(new Array<number>(BANDS).fill(0))).toBe(0);
    expect(run(low, 0.8).loud).toBeCloseTo(loudnessOf(low), 2);
  });

  it('the still glow is gentle and fuller in the bass; a held one keeps its levels', () => {
    const still = stillSpectrum();
    expect(Math.max(...still.level)).toBeLessThan(0.5);
    expect(still.level[0]).toBeGreaterThan(still.level[BANDS - 1]!);
    expect(still.t).toBe(0);
    expect(heldSpectrum([0.3, 0.8]).level[1]).toBeCloseTo(0.8);
  });
});

describe('shape', () => {
  it('a desktop bar: brightest by its right side, falling off toward the left', () => {
    const layout = layoutGlow(1200, 'right');
    expect(layout.centre).toBeCloseTo(1200 * ANCHOR.right);
    const s = heldSpectrum(new Array<number>(BANDS).fill(0.8));
    expect(heightAt(layout, s, layout.centre)).toBeGreaterThan(heightAt(layout, s, 100));
    expect(heightAt(layout, s, 100)).toBeGreaterThan(0.1);
    expect(gainAt(0, layout.arm)).toBe(1);
    expect(gainAt(layout.arm, layout.arm)).toBeCloseTo(0.32);
  });

  it('no bars: one loud band among quiet ones is a soft hill, never a step', () => {
    const layout = layoutGlow(1200, 'right');
    const levels = new Array<number>(BANDS).fill(0.1);
    levels[10] = 1;
    const s = heldSpectrum(levels);
    let prev = heightAt(layout, s, 0), steepest = 0;
    for (let x = 2; x <= 1200; x += 2) {
      const h = heightAt(layout, s, x);
      steepest = Math.max(steepest, Math.abs(h - prev));
      prev = h;
    }
    // at most about 1 % of the full height between two points 2 px apart
    expect(steepest).toBeLessThan(0.012);
    // the hill shows: higher over its band than far from it
    const hill = layout.centre - layout.spacing * 10.5;
    expect(heightAt(layout, s, hill)).toBeGreaterThan(heightAt(layout, s, hill - 8 * layout.sigma) * 1.5);
  });

  it('no crease at the mirror point, the same both ways', () => {
    const layout = layoutGlow(384, 'centre');
    const s = heldSpectrum(Array.from({ length: BANDS }, (_, i) => 1 - i / BANDS));
    const c = layout.centre;
    expect(heightAt(layout, s, c - 30)).toBeCloseTo(heightAt(layout, s, c + 30), 2);
    const left = heightAt(layout, s, c - 2), mid = heightAt(layout, s, c), right = heightAt(layout, s, c + 2);
    expect(Math.abs(mid - (left + right) / 2)).toBeLessThan(0.003);
    expect(layout.sigma).toBeGreaterThanOrEqual(MIN_SIGMA);
  });

  it('it flows: the same levels, a moment later, lie a little differently', () => {
    const layout = layoutGlow(1200, 'right');
    const raw = Array.from({ length: BANDS }, (_, i) => 0.3 + 0.4 * ((i * 7) % 5) / 5);
    const s = run(raw, 1);
    const before = heightAt(layout, s, 500);
    run(raw, 1.5, s);
    expect(Math.abs(heightAt(layout, s, 500) - before)).toBeGreaterThan(0.005);
  });

  it('no width, no light', () => {
    expect(heightAt(layoutGlow(0, 'right'), stillSpectrum(), 0)).toBe(0);
  });

  it('a colour at no alpha, for the light\'s fade', () => {
    expect(clearOf('rgb(95, 176, 204)')).toBe('rgba(95,176,204,0)');
    expect(clearOf('rgba(1, 2, 3, 0.5)')).toBe('rgba(1,2,3,0)');
    expect(clearOf('oklch(0.5 0.1 200)')).toBe('transparent');
  });
});
