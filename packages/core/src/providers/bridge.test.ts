/**
 * Bridge tests for fuzzy matching between MusicBrainz and search hits.
 */
import { describe, it, expect } from 'vitest';
import { fuzzyBridgeScore, chooseBestSearchHit, FUZZY_BRIDGE_ACCEPT } from './bridge.js';

describe('fuzzyBridgeScore', () => {
  it('should return high score for exact matches', () => {
    const mb = { title: 'Never Gonna Give You Up', artists: ['Rick Astley'], year: 1987 };
    const hit = { title: 'Never Gonna Give You Up', artists: ['Rick Astley'], year: 1987 };

    const score = fuzzyBridgeScore(mb, hit);

    expect(score).toBeGreaterThanOrEqual(0.95);
  });

  it('should return lower score for different artists', () => {
    const mb = { title: 'Test', artists: ['Artist A'], year: 2000 };
    const hit = { title: 'Test', artists: ['Artist B'], year: 2000 };

    const score = fuzzyBridgeScore(mb, hit);

    expect(score).toBeLessThan(FUZZY_BRIDGE_ACCEPT);
  });

  it('should handle year differences', () => {
    const base = { title: 'Album', artists: ['Artist'] };
    const hit = { title: 'Album', artists: ['Artist'] };

    // Same year
    const scoreExact = fuzzyBridgeScore({ ...base, year: 2000 }, { ...hit, year: 2000 });
    // Different year (+1)
    const score1Diff = fuzzyBridgeScore({ ...base, year: 2000 }, { ...hit, year: 2001 });
    // Different year (+3)
    const score3Diff = fuzzyBridgeScore({ ...base, year: 2000 }, { ...hit, year: 2003 });
    // Different year (+5)
    const score5Diff = fuzzyBridgeScore({ ...base, year: 2000 }, { ...hit, year: 2005 });

    expect(scoreExact).toBeGreaterThan(score1Diff);
    expect(score1Diff).toBeGreaterThan(score3Diff);
    expect(score3Diff).toBeGreaterThan(score5Diff);
  });

  it('should handle missing years as neutral', () => {
    const base = { title: 'Album', artists: ['Artist'] };
    const hit = { title: 'Album', artists: ['Artist'] };

    const scoreNoYears = fuzzyBridgeScore(base, hit);
    const scoreOneYear = fuzzyBridgeScore({ ...base, year: 2000 }, hit);

    // Both should be reasonable scores (year is 0.15 weight, so max diff is 0.15)
    expect(scoreNoYears).toBeGreaterThan(0.8);
    expect(scoreOneYear).toBeGreaterThan(0.8);
  });

  it('should handle title variations', () => {
    const base = { title: 'Thriller', artists: ['Michael Jackson'], year: 1982 };
    const closeMatch = { title: 'Thriller (Deluxe)', artists: ['Michael Jackson'], year: 1982 };
    const differentTitle = { title: 'Bad', artists: ['Michael Jackson'], year: 1987 };

    const closeScore = fuzzyBridgeScore(base, closeMatch);
    const diffScore = fuzzyBridgeScore(base, differentTitle);

    expect(closeScore).toBeGreaterThan(diffScore);
  });
});

describe('chooseBestSearchHit', () => {
  it('should select best candidate above threshold', () => {
    const target = { title: 'Album', artists: ['Artist'], year: 2000 };
    const candidates = [
      { title: 'Wrong Album', artists: ['Different Artist'], year: 2000 },
      { title: 'Album', artists: ['Artist'], year: 2000 },
      { title: 'Album Extended', artists: ['Artist'], year: 2000 },
    ];

    const result = chooseBestSearchHit(candidates, target);

    expect(result).not.toBeNull();
    expect(result?.index).toBe(1);
    expect(result?.score).toBeGreaterThanOrEqual(FUZZY_BRIDGE_ACCEPT);
  });

  it('should return null when no candidate meets threshold', () => {
    const target = { title: 'Album', artists: ['Artist'], year: 2000 };
    const candidates = [
      { title: 'Completely Different', artists: ['Someone Else'], year: 2020 },
      { title: 'Also Wrong', artists: ['Wrong Artist'], year: 2010 },
    ];

    const result = chooseBestSearchHit(candidates, target);

    expect(result).toBeNull();
  });

  it('should return null for empty candidates', () => {
    const target = { title: 'Album', artists: ['Artist'] };
    const result = chooseBestSearchHit([], target);
    expect(result).toBeNull();
  });
});

describe('FUZZY_BRIDGE_ACCEPT', () => {
  it('should be set to reasonable threshold', () => {
    expect(FUZZY_BRIDGE_ACCEPT).toBe(0.85);
  });
});
