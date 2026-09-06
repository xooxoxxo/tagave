/**
 * Track alignment guards (spec §12.5): oversized tracklists must not reach
 * the O(n³) Hungarian solver.
 */
import { describe, it, expect } from 'vitest';
import { alignTracks, MAX_ALIGN_TRACKS } from './scoring.js';

const local = (n: number) => Array.from({ length: n }, (_, i) => ({ title: `Song ${i + 1}`, duration: 200 + i, index: i }));
const canonical = (n: number) => Array.from({ length: n }, (_, i) => ({ title: `Song ${i + 1}`, duration: 200 + i, index: i }));

describe('alignTracks size guard', () => {
  it('aligns a normal album', () => {
    const out = alignTracks(local(6), canonical(6));
    expect(out).toHaveLength(6);
    expect(out.every((a) => a.canonicalIndex !== null && a.distance < 0.01)).toBe(true);
  });

  it('refuses a mega-compilation candidate quickly instead of padding to its size', () => {
    const t0 = performance.now();
    const out = alignTracks(local(6), canonical(MAX_ALIGN_TRACKS + 1));
    expect(performance.now() - t0).toBeLessThan(200);
    expect(out).toHaveLength(6);
    expect(out.every((a) => a.canonicalIndex === null && a.distance === 1)).toBe(true);
  });

  it('still aligns at the cap', () => {
    const out = alignTracks(local(3), canonical(MAX_ALIGN_TRACKS));
    expect(out.filter((a) => a.canonicalIndex !== null)).toHaveLength(3);
  });
});
