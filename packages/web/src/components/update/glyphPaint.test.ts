import { describe, expect, it } from 'vitest';
import { lavaBlobs, runProgress, seedTime } from './glyphPaint';
import { SIMULATED_END, nowAt, rolledBackRun, simulatedRun } from '../../stories/updateFixtures';

describe('the glyph grows with the run', () => {
  it('starts near nothing, only grows, and is whole on success', () => {
    const ps = [0, 18, 41, 46, 60, 84].map((t) => runProgress(simulatedRun(t), nowAt(t)));
    expect(ps[0]).toBeLessThan(0.02);
    for (let i = 1; i < ps.length; i++) expect(ps[i]).toBeGreaterThan(ps[i - 1]!);
    expect(ps.at(-1)).toBeLessThan(1);
    expect(runProgress(simulatedRun(SIMULATED_END), nowAt(SIMULATED_END))).toBe(1);
  });

  it('holds where a failed run stopped', () => {
    const p = runProgress(rolledBackRun(), nowAt(400));
    expect(p).toBeGreaterThan(0.4);
    expect(p).toBeLessThan(1);
  });
});

describe('the lamp', () => {
  it('is the same piece for the same version, another for another', () => {
    expect(lavaBlobs('0.13.0', 600, 380)).toEqual(lavaBlobs('0.13.0', 600, 380));
    expect(lavaBlobs('0.13.0', 600, 380)).not.toEqual(lavaBlobs('0.13.1', 600, 380));
    expect(seedTime('0.13.0')).toBe(seedTime('0.13.0'));
  });

  it('spans the piece edge to edge: each blob rests in its own slice of the width', () => {
    for (const seed of ['0.12.0', '0.14.1', 'tagave']) {
      const w = 1600;
      const xs = lavaBlobs(seed, w, 560).map((b) => b.bx);
      const slice = (0.8 * w) / xs.length;
      xs.forEach((x, i) => {
        expect(x).toBeGreaterThan(0.1 * w + i * slice);
        expect(x).toBeLessThan(0.1 * w + (i + 1) * slice);
      });
      expect(xs[0]!).toBeLessThan(0.3 * w);
      expect(xs.at(-1)!).toBeGreaterThan(0.7 * w);
    }
  });

  it('moves slowly: every blob loops in tens of seconds, never faster than 15 s', () => {
    for (const seed of ['0.12.0', '0.13.0', 'tagave']) {
      const blobs = lavaBlobs(seed, 1280, 860);
      expect(blobs.length).toBeGreaterThanOrEqual(4);
      expect(blobs.length).toBeLessThanOrEqual(6);
      for (const b of blobs) for (const period of [b.px, b.py, b.pr]) expect(period).toBeGreaterThanOrEqual(15);
    }
  });
});
