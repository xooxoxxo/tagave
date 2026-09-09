/**
 * Track alignment guards (spec §12.5): oversized tracklists must not reach
 * the O(n³) Hungarian solver.
 */
import { describe, it, expect } from 'vitest';
import { alignTracks, scoreRelease, MAX_ALIGN_TRACKS } from './scoring.js';
import { chipCounts } from './chipRule.js';

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

  it('judges by title alone when the candidate carries no durations (Discogs)', () => {
    const noDurations = canonical(6).map((t) => ({ ...t, duration: 0 }));
    const out = alignTracks(local(6), noDurations);
    expect(out.every((a) => a.canonicalIndex === a.localIndex && a.distance < 0.01)).toBe(true);
    // a wrong title still costs, so an unrelated tracklist does not align for free
    const wrong = noDurations.map((t, i) => ({ ...t, title: `Other ${i}` }));
    expect(alignTracks(local(6), wrong).every((a) => a.distance > 0.3)).toBe(true);
  });
});

/**
 * Per-medium alignment and the disc-count component (XO-379). The shape is
 * the owner's "Liebe ist für alle da" case: a two-CD album stored as sibling
 * CD1/CD2 folders, 11 + 5 tracks, against a one-CD 16-track release and
 * against the two-disc edition.
 */
const discTracks = (disc: number, from: number, count: number, offset = 0) =>
  Array.from({ length: count }, (_, i) => ({
    title: `D${disc} Song ${i + 1}`,
    duration: 200 + i,
    index: offset + i,
    disc,
    position: from + i,
  }));

const twoDiscLocal = [...discTracks(1, 1, 11, 0), ...discTracks(2, 1, 5, 11)];

const mediumTracks = (medium: number, count: number, offset = 0, label = medium) =>
  Array.from({ length: count }, (_, i) => ({
    title: `D${label} Song ${i + 1}`,
    duration: 200 + i,
    index: offset + i,
    medium,
  }));

// Everything on one medium, but the same 16 titles the local set has.
const oneMediumRelease = {
  id: 'rel-1cd',
  releaseGroupId: 'rg',
  title: 'Liebe ist fur alle da',
  artists: ['Rammstein'],
  tracks: [...mediumTracks(1, 11, 0, 1), ...mediumTracks(1, 5, 11, 2)],
  mediumCount: 1,
  source: 'musicbrainz' as const,
};

const twoMediumRelease = {
  ...oneMediumRelease,
  id: 'rel-2cd',
  tracks: [...mediumTracks(1, 11, 0), ...mediumTracks(2, 5, 11)],
  mediumCount: 2,
};

const localAlbum = {
  artist: 'Rammstein',
  title: 'Liebe ist fur alle da',
  tracks: twoDiscLocal,
  discCount: 2,
};

describe('per-medium alignment', () => {
  it('leaves a disc with no matching medium unaligned', () => {
    const out = alignTracks(twoDiscLocal, oneMediumRelease.tracks);
    expect(out).toHaveLength(16);
    // disc 1 aligns against medium 1; disc 2 has no medium 2 at all
    expect(out.slice(0, 11).every((a) => a.canonicalIndex !== null)).toBe(true);
    expect(out.slice(11).every((a) => a.canonicalIndex === null && a.distance === 1)).toBe(true);
  });

  it('aligns every disc against its own medium', () => {
    const out = alignTracks(twoDiscLocal, twoMediumRelease.tracks);
    expect(out.every((a) => a.canonicalIndex !== null && a.distance < 0.01)).toBe(true);
    expect(out.map((a) => a.canonicalIndex)).toEqual(out.map((a) => a.localIndex));
  });

  it('does not pair a disc-2 track with a medium-1 track of the same title', () => {
    // The disc-2 track's title exists verbatim on medium 1; medium 2 holds
    // something else entirely, so the honest answer is "no match".
    const local = [
      { title: 'Opening', duration: 200, index: 0, disc: 1, position: 1 },
      { title: 'Shared Title', duration: 240, index: 1, disc: 2, position: 1 },
    ];
    const canonical = [
      { title: 'Opening', duration: 200, index: 0, medium: 1 },
      { title: 'Shared Title', duration: 240, index: 1, medium: 1 },
      { title: 'Completely Different', duration: 500, index: 2, medium: 2 },
    ];
    const out = alignTracks(local, canonical);
    expect(out[0]!.canonicalIndex).toBe(0);
    expect(out[1]!.canonicalIndex).not.toBe(1);
    // medium 2's only track is 260 s away, so the hard cap forbids it
    expect(out[1]!.canonicalIndex).toBeNull();
  });

  it('keeps the flat alignment when the local side knows no discs', () => {
    const discless = twoDiscLocal.map(({ disc, position, ...rest }) => {
      void disc; void position;
      return rest;
    });
    const withMedia = alignTracks(discless, twoMediumRelease.tracks);
    const withoutMedia = alignTracks(
      discless,
      twoMediumRelease.tracks.map(({ medium, ...rest }) => { void medium; return rest; }),
    );
    expect(withMedia).toEqual(withoutMedia);
    expect(withMedia.every((a) => a.canonicalIndex === a.localIndex)).toBe(true);
    // the pre-existing fixture is untouched by the new code path
    expect(alignTracks(local(6), canonical(6))).toEqual(
      alignTracks(local(6), canonical(6).map((t) => ({ ...t }))),
    );
  });
});

describe('medium count component', () => {
  it('prefers the two-disc edition over the one-disc release for a two-disc cluster', () => {
    const oneCd = scoreRelease(localAlbum, oneMediumRelease);
    const twoCd = scoreRelease(localAlbum, twoMediumRelease);
    expect(twoCd.distance).toBeLessThan(oneCd.distance);
    expect(twoCd.breakdown.mediums).toBe(0);
    expect(oneCd.breakdown.mediums).toBe(0.5); // |2-1| / max(2,1)
    // a red chip on the wrong one blocks the owner's chip-rule auto-accept
    expect(chipCounts(oneCd.breakdown).reds).toBeGreaterThan(0);
    expect(chipCounts(twoCd.breakdown).reds).toBe(0);
    // and the disc-2 half really is reported as unmatched/missing
    expect(oneCd.breakdown.unmatchedTracks).toBeGreaterThan(0);
    expect(oneCd.breakdown.missingTracks).toBeGreaterThan(0);
  });

  it('stays out of the breakdown when either side does not know its disc count', () => {
    const { discCount, ...noDiscCount } = localAlbum;
    void discCount;
    expect(scoreRelease(noDiscCount, twoMediumRelease).breakdown.mediums).toBeUndefined();
    const { mediumCount, ...noMediumCount } = twoMediumRelease;
    void mediumCount;
    expect(scoreRelease(localAlbum, noMediumCount).breakdown.mediums).toBeUndefined();
  });
});
