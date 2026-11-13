import { describe, it, expect } from 'vitest';
import { MATCHING_THRESHOLDS, chipCounts, pickByChipRule } from '@tagave/core';
import { identifyDecision, type DecisionCandidate, type DecisionLocal, type IdentifyDecision } from './identifyDecision.js';

const c = (id: string, distance: number, breakdown: Record<string, number>, over: Partial<DecisionCandidate> = {}): DecisionCandidate =>
  ({ id, distance, breakdown, trackCount: 10, mediumCount: 1, ...over });
const local = { trackCount: 10, discsKnown: false, localDiscs: 0 };
const green = { album: 0, artist: 0, tracks: 0, trackTitle: 0 };

describe('identifyDecision', () => {
  it('nothing scored is none', () => expect(identifyDecision([], local)).toEqual({ kind: 'none' }));
  it('strong with track parity and no close second', () =>
    expect(identifyDecision([c('a', 0.02, green), c('b', 0.4, green)], local)).toEqual({ kind: 'strong', id: 'a' }));
  it('a close second in the band demotes a strong one to the chip rule', () =>
    expect(identifyDecision([c('a', 0.02, { ...green, year: 0.1 }), c('b', 0.1, green)], local)).toEqual({ kind: 'chip_rule', id: 'b' }));
  it('no chip-rule pass and no red takes the first candidate', () =>
    expect(identifyDecision([c('a', 0.2, { album: 0.2, artist: 0.1 })], local)).toEqual({ kind: 'first_candidate', id: 'a' }));
  it('a red holds the album', () =>
    expect(identifyDecision([c('a', 0.2, { album: 0.6, artist: 0 })], local)).toEqual({ kind: 'held' }));
  it('more media than the local discs holds it when discs are known', () =>
    expect(identifyDecision([c('a', 0.2, { album: 0.2 }, { mediumCount: 2 })], { ...local, discsKnown: true, localDiscs: 1 })).toEqual({ kind: 'held' }));
  it('outside the band is weak', () => expect(identifyDecision([c('a', 0.3, green)], local)).toEqual({ kind: 'weak' }));
});

/**
 * The decision block as it stood inline in identify.album before it became a
 * pure function, kept verbatim in its branch order. `persisted` stands in for
 * the release-id lookup; every outcome is mapped onto the new decision shape.
 */
function inlineDecision(scored: DecisionCandidate[], local: DecisionLocal, persisted: (id: string) => boolean): IdentifyDecision {
  const best = scored[0];
  const second = scored[1];
  const bestDb = best ? persisted(best.id) : false;
  const gapDemoted = best && second && second.distance - best.distance < MATCHING_THRESHOLDS.recGapThresh
    && second.distance <= MATCHING_THRESHOLDS.medium && best.distance > 0;
  const trackParity = best ? best.trackCount === local.trackCount : false;
  if (best && bestDb && best.distance <= MATCHING_THRESHOLDS.strong && trackParity && !gapDemoted) {
    return { kind: 'strong', id: best.id };
  } else if (best && best.distance <= MATCHING_THRESHOLDS.medium) {
    const inBand = scored.filter((x) => x.distance <= MATCHING_THRESHOLDS.medium);
    const pick = pickByChipRule(inBand.map((x) => ({ breakdown: x.breakdown, distance: x.distance })));
    const chosen = pick >= 0 ? inBand[pick] : undefined;
    if (chosen && persisted(chosen.id)) return { kind: 'chip_rule', id: chosen.id };
    if (best && bestDb) {
      const cc2 = chipCounts(best.breakdown);
      const mediaCount = best.mediumCount;
      const discsKnown = local.discsKnown;
      const localDiscs = discsKnown ? local.localDiscs : 0;
      if (cc2.reds === 0 && (!discsKnown || mediaCount === 0 || mediaCount <= localDiscs)) {
        return { kind: 'first_candidate', id: best.id };
      }
    }
    return { kind: 'held' };
  }
  return best ? { kind: 'weak' } : { kind: 'none' };
}

/** What identify.album now does with the pure decision: a pick it cannot find persisted is held. */
function appliedDecision(scored: DecisionCandidate[], local: DecisionLocal, persisted: (id: string) => boolean): IdentifyDecision {
  const d = identifyDecision(scored, local);
  if ('id' in d && !persisted(d.id)) return { kind: 'held' };
  return d;
}

/** Small deterministic PRNG so a failure reproduces from its seed. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Values chosen to sit on and around every threshold the decision reads.
const DISTANCES = [0, 0.01, 0.02, 0.04, 0.0401, 0.1, 0.2, 0.249, 0.25, 0.2501, 0.29, 0.3, 0.5];
const CHIPS = [0, 0, 0, 0.1, 0.3, 0.49, 0.5, 0.8, Number.NaN];
const KEYS = ['album', 'artist', 'tracks', 'trackTitle', 'year', 'albumId', 'media'];

function randomCase(r: () => number): { scored: DecisionCandidate[]; local: DecisionLocal } {
  const n = Math.floor(r() * 5);
  const scored: DecisionCandidate[] = [];
  for (let i = 0; i < n; i++) {
    const breakdown: Record<string, unknown> = {};
    for (const k of KEYS) if (r() < 0.7) breakdown[k] = CHIPS[Math.floor(r() * CHIPS.length)];
    if (r() < 0.05) breakdown.note = 'text';
    scored.push({
      id: `r${i}`,
      distance: DISTANCES[Math.floor(r() * DISTANCES.length)]!,
      breakdown,
      trackCount: [9, 10, 11, 0][Math.floor(r() * 4)]!,
      mediumCount: [0, 1, 2, 3][Math.floor(r() * 4)]!,
    });
  }
  // the scorer hands candidates over best first
  scored.sort((a, b) => a.distance - b.distance);
  const discsKnown = r() < 0.5;
  return { scored, local: { trackCount: 10, discsKnown, localDiscs: discsKnown ? 1 + Math.floor(r() * 3) : 0 } };
}

describe('identifyDecision against the former inline decision', () => {
  it('agrees on every case when every candidate release is persisted', () => {
    const r = rng(20261027);
    const seen = new Set<string>();
    for (let i = 0; i < 20000; i++) {
      const { scored, local: l } = randomCase(r);
      const before = inlineDecision(scored, l, () => true);
      expect(identifyDecision(scored, l), JSON.stringify({ scored, l })).toEqual(before);
      seen.add(before.kind);
    }
    // the generator must reach every outcome, or the comparison proves little
    expect([...seen].sort()).toEqual(['chip_rule', 'first_candidate', 'held', 'none', 'strong', 'weak']);
  });

  it('agrees whenever the release it picks is persisted, even if others are not', () => {
    const r = rng(7);
    let compared = 0;
    for (let i = 0; i < 20000; i++) {
      const { scored, local: l } = randomCase(r);
      const missing = new Set(scored.filter(() => r() < 0.3).map((s) => s.id));
      const persisted = (id: string) => !missing.has(id);
      const d = identifyDecision(scored, l);
      if ('id' in d && !persisted(d.id)) continue;
      expect(appliedDecision(scored, l, persisted), JSON.stringify({ scored, l, missing: [...missing] })).toEqual(inlineDecision(scored, l, persisted));
      compared++;
    }
    expect(compared).toBeGreaterThan(10000);
  });

  it('holds a pick whose release was not persisted, where the inline path fell through', () => {
    // strong best not persisted: the inline path went on to the chip rule
    const scored = [c('a', 0.02, green), c('b', 0.4, green)];
    expect(inlineDecision(scored, local, (id) => id !== 'a')).toEqual({ kind: 'held' });
    expect(appliedDecision(scored, local, (id) => id !== 'a')).toEqual({ kind: 'held' });
    // chip-rule pick not persisted: the inline path took the first candidate instead
    const band = [c('a', 0.1, { album: 0.1 }), c('b', 0.2, green)];
    expect(inlineDecision(band, local, (id) => id !== 'b')).toEqual({ kind: 'first_candidate', id: 'a' });
    expect(appliedDecision(band, local, (id) => id !== 'b')).toEqual({ kind: 'held' });
  });
});
