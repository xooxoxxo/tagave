/**
 * Track alignment guards (spec §12.5): oversized tracklists must not reach
 * the O(n³) Hungarian solver.
 */
import { describe, it, expect } from 'vitest';
import { alignTracks, scoreRelease, mediumCountOf, MAX_ALIGN_TRACKS } from './scoring.js';
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
 * Media awareness (XO-379). Two shapes drive these: the owner's "Liebe ist für
 * alle da" — a two-CD album stored as sibling CD1/CD2 folders, 11 + 5 tracks,
 * against a one-CD 16-track release and against the two-disc edition — and the
 * ~260 prod albums that sit in a single folder with disk.no > 1 tagged on
 * every file.
 */
const discTracks = (disc: number, count: number, offset = 0, label: number = disc) =>
  Array.from({ length: count }, (_, i) => ({
    title: `D${label} Song ${i + 1}`,
    duration: 200 + i,
    index: offset + i,
    disc,
  }));

const mediumTracks = (medium: number, count: number, offset = 0, label: number = medium) =>
  Array.from({ length: count }, (_, i) => ({
    title: `D${label} Song ${i + 1}`,
    duration: 200 + i,
    index: offset + i,
    medium,
  }));

const twoDiscLocal = [...discTracks(1, 11, 0), ...discTracks(2, 5, 11)];
const disclessLocal = twoDiscLocal.map(({ title, duration, index }) => ({ title, duration, index }));

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

const twoDiscAlbum = {
  artist: 'Rammstein',
  title: 'Liebe ist fur alle da',
  tracks: twoDiscLocal,
  discsKnown: true,
  discCount: 2,
};

/** A plain one-disc album and one-CD release, with no disc information anywhere. */
const flatTracks = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ title: `Song ${i + 1}`, duration: 200 + i, index: i }));
const flatAlbum = { artist: 'Rammstein', title: 'Reise Reise', tracks: flatTracks(11) };
const flatRelease = {
  id: 'rel-flat',
  releaseGroupId: 'rg',
  title: 'Reise Reise',
  artists: ['Rammstein'],
  tracks: flatTracks(11),
  source: 'musicbrainz' as const,
};

describe('one-disc albums are left alone', () => {
  it('scores a flat album exactly as it did before media awareness', () => {
    const out = scoreRelease(flatAlbum, flatRelease);
    // The pre-XO-379 breakdown, key for key and value for value.
    expect(out.breakdown).toEqual({ artist: 0, album: 0, tracks: 0, trackTitle: 0 });
    expect(Object.keys(out.breakdown).sort()).toEqual(['album', 'artist', 'trackTitle', 'tracks']);
    expect(out.distance).toBe(0);
  });

  it('adds no chip when both sides say "one disc"', () => {
    // Every numeric key in the breakdown is a chip, and chipRule counts them:
    // writing mediums: 0 for the ordinary 1-vs-1 album handed the whole
    // library a free green chip (the reason the first attempt was reverted).
    const bare = scoreRelease(flatAlbum, flatRelease);
    const declared = scoreRelease(
      { ...flatAlbum, discsKnown: true, discCount: 1 },
      { ...flatRelease, tracks: flatRelease.tracks.map((t) => ({ ...t, medium: 1 })), mediumCount: 1 },
    );
    expect(declared.breakdown.mediums).toBeUndefined();
    expect(declared.breakdown).toEqual(bare.breakdown);
    expect(declared.distance).toBe(bare.distance);
    expect(chipCounts(declared.breakdown).greens).toBe(chipCounts(bare.breakdown).greens);
  });

  it('keeps the flat alignment when the album knows no discs', () => {
    // A 2-CD set ripped flat into one folder: nothing on disk says "disc", so
    // the matcher may not invent one. It must still align against the
    // two-medium release that is the right answer.
    const withMedia = alignTracks(disclessLocal, twoMediumRelease.tracks);
    const withoutMedia = alignTracks(
      disclessLocal,
      twoMediumRelease.tracks.map(({ title, duration, index }) => ({ title, duration, index })),
    );
    expect(withMedia).toEqual(withoutMedia);
    expect(withMedia.every((a) => a.canonicalIndex === a.localIndex)).toBe(true);

    const scored = scoreRelease(
      { artist: 'Rammstein', title: 'Liebe ist fur alle da', tracks: disclessLocal },
      twoMediumRelease,
    );
    expect(scored.breakdown.mediums).toBeUndefined();
    expect(scored.breakdown.missingTracks).toBeUndefined();
    expect(scored.breakdown.unmatchedTracks).toBeUndefined();
    expect(scored.distance).toBe(0);
  });

  it('keeps the flat alignment for a folder tagged disc 2 throughout', () => {
    // Prod has ~260 of these. One disc value, however high, is one disc: the
    // tracks must still align against a one-medium release's tracklist.
    const discTwoOnly = discTracks(2, 5, 0, 1);
    const oneCd = {
      ...oneMediumRelease,
      id: 'rel-single',
      tracks: mediumTracks(1, 5, 0, 1),
      mediumCount: 1,
    };
    const out = alignTracks(discTwoOnly, oneCd.tracks);
    expect(out.every((a) => a.canonicalIndex === a.localIndex && a.distance < 0.01)).toBe(true);

    // The medium component reads the album's disc count, not the alignment: a
    // view that claims two discs still gets the mismatch chip...
    const claimsTwo = scoreRelease(
      { artist: 'Rammstein', title: 'Liebe ist fur alle da', tracks: discTwoOnly, discsKnown: true, discCount: 2 },
      oneCd,
    );
    expect(claimsTwo.breakdown.mediums).toBe(0.5); // |2-1| / max(2,1)
    expect(claimsTwo.breakdown.trackTitle).toBe(0);
    expect(claimsTwo.breakdown.unmatchedTracks).toBeUndefined();
    // ...while the shape the builder actually produces for this album — one
    // distinct disc number — is a one-disc album against a one-CD release, so
    // no chip at all.
    const asBuilt = scoreRelease(
      { artist: 'Rammstein', title: 'Liebe ist fur alle da', tracks: discTwoOnly, discsKnown: true, discCount: 1 },
      oneCd,
    );
    expect(asBuilt.breakdown.mediums).toBeUndefined();
    expect(asBuilt.distance).toBe(0);
  });
});

describe('per-medium alignment', () => {
  it('aligns disc against medium by rank when both sides are multi-disc', () => {
    const out = alignTracks(twoDiscLocal, twoMediumRelease.tracks);
    expect(out.every((a) => a.canonicalIndex !== null && a.distance < 0.01)).toBe(true);
    expect(out.map((a) => a.canonicalIndex)).toEqual(out.map((a) => a.localIndex));
  });

  it('does not pair a disc-2 track with a medium-1 track of the same title', () => {
    // The disc-2 track's title exists verbatim on medium 1; medium 2 holds
    // something else entirely, so the honest answer is "no match".
    const local = [
      { title: 'Opening', duration: 200, index: 0, disc: 1 },
      { title: 'Shared Title', duration: 240, index: 1, disc: 2 },
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

  it('pairs by rank, not by absolute disc number', () => {
    // A box-set fragment tagged discs 3 and 4 against a two-medium release:
    // rank 1 is disc 3 against medium 1, rank 2 is disc 4 against medium 2.
    // Keying on the number itself would align both discs against nothing.
    const shifted = [...discTracks(3, 11, 0, 1), ...discTracks(4, 5, 11, 2)];
    const out = alignTracks(shifted, twoMediumRelease.tracks);
    expect(out.every((a) => a.canonicalIndex === a.localIndex && a.distance < 0.01)).toBe(true);

    // and it really is rank pairing, not the flat alignment falling on its
    // feet: a disc-4 title that also exists on medium 1 still must not pair.
    const trap = alignTracks(
      [
        { title: 'Opening', duration: 200, index: 0, disc: 3 },
        { title: 'Shared Title', duration: 240, index: 1, disc: 4 },
      ],
      [
        { title: 'Opening', duration: 200, index: 0, medium: 1 },
        { title: 'Shared Title', duration: 240, index: 1, medium: 1 },
        { title: 'Completely Different', duration: 500, index: 2, medium: 2 },
      ],
    );
    expect(trap[0]!.canonicalIndex).toBe(0);
    expect(trap[1]!.canonicalIndex).toBeNull();
  });

  it('leaves a local disc with no counterpart rank unaligned', () => {
    const threeDisc = [...discTracks(1, 4, 0, 1), ...discTracks(2, 4, 4, 2), ...discTracks(3, 4, 8, 3)];
    const out = alignTracks(threeDisc, twoMediumRelease.tracks.slice(0, 11).concat(mediumTracks(2, 4, 11, 2)));
    expect(out.slice(0, 8).every((a) => a.canonicalIndex !== null)).toBe(true);
    expect(out.slice(8).every((a) => a.canonicalIndex === null && a.distance === 1)).toBe(true);
  });
});

describe('medium count component', () => {
  it('prefers the two-disc edition over the one-disc release for a two-disc cluster', () => {
    const oneCd = scoreRelease(twoDiscAlbum, oneMediumRelease);
    const twoCd = scoreRelease(twoDiscAlbum, twoMediumRelease);
    expect(oneCd.breakdown.mediums).toBe(0.5); // |2-1| / max(2,1)
    expect(twoCd.breakdown.mediums).toBe(0);
    expect(twoCd.distance).toBeLessThan(oneCd.distance);
    // a red chip on the wrong one blocks the owner's chip-rule auto-accept
    expect(chipCounts(oneCd.breakdown).reds).toBeGreaterThan(0);
    expect(chipCounts(twoCd.breakdown).reds).toBe(0);
    // the one-CD release still aligns all 16 titles flat (one medium), so the
    // disc count is the only thing telling the two editions apart
    expect(oneCd.breakdown.trackTitle).toBe(0);
    expect(oneCd.breakdown.unmatchedTracks).toBeUndefined();
  });

  it('stays out of the breakdown unless the album knows its discs', () => {
    expect(
      scoreRelease(
        { artist: 'Rammstein', title: 'Liebe ist fur alle da', tracks: twoDiscLocal, discCount: 2 },
        twoMediumRelease,
      ).breakdown.mediums,
    ).toBeUndefined();
    expect(
      scoreRelease(
        { artist: 'Rammstein', title: 'Liebe ist fur alle da', tracks: twoDiscLocal, discsKnown: false, discCount: 2 },
        oneMediumRelease,
      ).breakdown.mediums,
    ).toBeUndefined();
    // nor when the candidate never said how many media it has
    const { mediumCount, ...noMediumCount } = twoMediumRelease;
    void mediumCount;
    expect(scoreRelease(twoDiscAlbum, noMediumCount).breakdown.mediums).toBeUndefined();
  });
});

describe('mediumCountOf', () => {
  it('trusts the per-track medium over the release-level media list', () => {
    // Discogs folds a 2xCD into one format entry; the tracklist knows better.
    expect(mediumCountOf({
      tracks: [{ mediumNumber: 1 }, { mediumNumber: 2 }],
      mediaList: [{ position: 1, format: '2xCD', trackCount: 16 }],
    })).toBe(2);
  });

  it('falls back to the media list, then to unknown', () => {
    expect(mediumCountOf({ tracks: [], mediaList: [{ position: 1, format: 'CD', trackCount: 5 }] })).toBe(1);
    expect(mediumCountOf({ tracks: [] })).toBeUndefined();
    expect(mediumCountOf({})).toBeUndefined();
    expect(mediumCountOf({ tracks: [{ mediumNumber: 3 }, { mediumNumber: 1 }] })).toBe(3);
  });
});
