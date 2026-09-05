import { describe, expect, it } from 'vitest';
import { chipCounts, pickByChipRule } from './chipRule.js';

describe('chipCounts', () => {
  it('counts greens/yellows/reds with UI thresholds', () => {
    const c = chipCounts({ artist: 0, album: 0, tracks: 0, year: 0.2, country: 0.5 });
    expect(c).toEqual({ greens: 3, yellows: 1, reds: 1, passes: false });
  });

  it('passes with three greens, no reds', () => {
    expect(chipCounts({ artist: 0, album: 0, tracks: 0, year: 0.3 }).passes).toBe(true);
  });

  it('fails with only two greens', () => {
    expect(chipCounts({ artist: 0, album: 0, year: 0.1 }).passes).toBe(false);
  });

  it('fails on any red even with many greens', () => {
    expect(chipCounts({ a: 0, b: 0, c: 0, d: 0, e: 0.9 }).passes).toBe(false);
  });

  it('ignores non-numeric values like the queue UI does', () => {
    expect(chipCounts({ a: 0, b: 0, c: 0, note: 'x' as unknown as number }).passes).toBe(true);
  });

  it('handles null/empty', () => {
    expect(chipCounts(null).passes).toBe(false);
    expect(chipCounts({}).passes).toBe(false);
  });
});

describe('pickByChipRule', () => {
  it('prefers fewest yellows over lowest distance', () => {
    const i = pickByChipRule([
      { breakdown: { a: 0, b: 0, c: 0, d: 0.1, e: 0.1 }, distance: 0.05 },
      { breakdown: { a: 0, b: 0, c: 0, d: 0.1 }, distance: 0.08 },
    ]);
    expect(i).toBe(1);
  });

  it('breaks yellow ties by distance', () => {
    const i = pickByChipRule([
      { breakdown: { a: 0, b: 0, c: 0, d: 0.1 }, distance: 0.09 },
      { breakdown: { a: 0, b: 0, c: 0, d: 0.2 }, distance: 0.04 },
    ]);
    expect(i).toBe(1);
  });

  it('returns -1 when nothing passes', () => {
    expect(pickByChipRule([{ breakdown: { a: 0, b: 0.6 }, distance: 0.1 }])).toBe(-1);
    expect(pickByChipRule([])).toBe(-1);
  });
});
