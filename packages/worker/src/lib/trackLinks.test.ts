/**
 * Pure unit tests for track linking helpers (0026).
 * Tests localTrackViews and canonicalTrackViews without a database.
 */

import { describe, it, expect } from 'vitest';
import { localTrackViews, canonicalTrackViews, planTrackLinks } from './trackLinks.js';

describe('localTrackViews', () => {
  it('should sort by (disc??1, track??0) and build LocalTrack array', () => {
    const rows = [
      { id: '1', discNo: 2, trackNo: 1, titleGuess: 'B1', artistGuess: 'Artist', durationMs: 180000 },
      { id: '2', discNo: 1, trackNo: 2, titleGuess: 'A2', artistGuess: 'Artist', durationMs: 200000 },
      { id: '3', discNo: 1, trackNo: 1, titleGuess: 'A1', artistGuess: 'Artist', durationMs: 150000 },
    ];

    const result = localTrackViews(rows);

    // Sorted: disc 1 (tracks 1, 2), then disc 2 (track 1)
    expect(result.order).toEqual([rows[2], rows[1], rows[0]]);
    expect(result.tracks).toHaveLength(3);
    expect(result.tracks[0]?.title).toBe('A1');
    expect(result.tracks[1]?.title).toBe('A2');
    expect(result.tracks[2]?.title).toBe('B1');
    expect(result.discsKnown).toBe(true);
    expect(result.discCount).toBe(2);
  });

  it('should handle missing disc numbers as disc 1', () => {
    const rows = [
      { id: '1', discNo: null, trackNo: 2, titleGuess: 'T2', artistGuess: 'Artist', durationMs: 200000 },
      { id: '2', discNo: null, trackNo: 1, titleGuess: 'T1', artistGuess: 'Artist', durationMs: 150000 },
    ];

    const result = localTrackViews(rows);

    expect(result.order).toEqual([rows[1], rows[0]]);
    expect(result.discsKnown).toBe(false);
    expect(result.discCount).toBe(1);
  });

  it('should convert duration from ms to seconds', () => {
    const rows = [
      { id: '1', discNo: null, trackNo: 1, titleGuess: 'Track', artistGuess: 'Artist', durationMs: 180000 },
    ];

    const result = localTrackViews(rows);

    expect(result.tracks[0]?.duration).toBe(180); // 180000 / 1000
  });

  it('should include disc in LocalTrack only when discsKnown', () => {
    const rows1 = [
      { id: '1', discNo: null, trackNo: 1, titleGuess: 'T', artistGuess: null, durationMs: 100000 },
    ];
    const result1 = localTrackViews(rows1);
    expect(result1.tracks[0]).not.toHaveProperty('disc');

    const rows2 = [
      { id: '1', discNo: 1, trackNo: 1, titleGuess: 'T', artistGuess: null, durationMs: 100000 },
    ];
    const result2 = localTrackViews(rows2);
    expect(result2.tracks[0]?.disc).toBe(1);
  });

  it('should not mutate input rows', () => {
    const rows = [
      { id: '1', discNo: 2, trackNo: 1, titleGuess: 'B', artistGuess: 'Artist', durationMs: 180000 },
      { id: '2', discNo: 1, trackNo: 1, titleGuess: 'A', artistGuess: 'Artist', durationMs: 150000 },
    ];
    const originalOrder = [rows[0], rows[1]];

    localTrackViews(rows);

    expect(rows).toEqual(originalOrder);
  });

  it('should compute correct disc count from non-null disc numbers', () => {
    const rows = [
      { id: '1', discNo: 3, trackNo: 1, titleGuess: 'T1', artistGuess: null, durationMs: 100000 },
      { id: '2', discNo: 1, trackNo: 1, titleGuess: 'T2', artistGuess: null, durationMs: 100000 },
      { id: '3', discNo: 1, trackNo: 2, titleGuess: 'T3', artistGuess: null, durationMs: 100000 },
      { id: '4', discNo: null, trackNo: 1, titleGuess: 'T4', artistGuess: null, durationMs: 100000 },
    ];

    const result = localTrackViews(rows);

    expect(result.discCount).toBe(2); // discs 1 and 3
  });
});

describe('canonicalTrackViews', () => {
  it('should sort by (mediumNo, position) and build MatchingCanonicalTrack array', () => {
    const rows = [
      { id: '1', mediumNo: 2, position: 1, title: 'B1', artistCredit: [{ name: 'Artist', mbid: 'a' }], lengthMs: 180000, recordingMbid: null, trackMbid: null },
      { id: '2', mediumNo: 1, position: 2, title: 'A2', artistCredit: [{ name: 'Artist', mbid: 'a' }], lengthMs: 200000, recordingMbid: null, trackMbid: null },
      { id: '3', mediumNo: 1, position: 1, title: 'A1', artistCredit: [{ name: 'Artist', mbid: 'a' }], lengthMs: 150000, recordingMbid: 'rec-1', trackMbid: 'track-1' },
    ];

    const result = canonicalTrackViews(rows);

    expect(result.order).toEqual([rows[2], rows[1], rows[0]]);
    expect(result.tracks).toHaveLength(3);
    expect(result.tracks[0]?.title).toBe('A1');
    expect(result.tracks[1]?.title).toBe('A2');
    expect(result.tracks[2]?.title).toBe('B1');
  });

  it('should convert duration from ms to seconds', () => {
    const rows = [
      { id: '1', mediumNo: 1, position: 1, title: 'Track', artistCredit: [], lengthMs: 180000, recordingMbid: null, trackMbid: null },
    ];

    const result = canonicalTrackViews(rows);

    expect(result.tracks[0]?.duration).toBe(180);
  });

  it('should extract artist names from artistCredit array', () => {
    const rows = [
      { id: '1', mediumNo: 1, position: 1, title: 'Track', artistCredit: [{ name: 'Artist A', mbid: 'a' }, { name: 'Artist B', mbid: 'b' }], lengthMs: 100000, recordingMbid: null, trackMbid: null },
    ];

    const result = canonicalTrackViews(rows);

    expect(result.tracks[0]?.artist).toBe('Artist A; Artist B');
  });

  it('should set recordingId from recordingMbid', () => {
    const rows = [
      { id: '1', mediumNo: 1, position: 1, title: 'Track', artistCredit: [], lengthMs: 100000, recordingMbid: 'rec-123', trackMbid: null },
    ];

    const result = canonicalTrackViews(rows);

    expect(result.tracks[0]?.recordingId).toBe('rec-123');
  });

  it('should include medium when mediumNo is not null', () => {
    const rows1 = [
      { id: '1', mediumNo: null, position: 1, title: 'Track', artistCredit: [], lengthMs: 100000, recordingMbid: null, trackMbid: null },
    ];
    const result1 = canonicalTrackViews(rows1);
    expect(result1.tracks[0]).not.toHaveProperty('medium');

    const rows2 = [
      { id: '1', mediumNo: 2, position: 1, title: 'Track', artistCredit: [], lengthMs: 100000, recordingMbid: null, trackMbid: null },
    ];
    const result2 = canonicalTrackViews(rows2);
    expect(result2.tracks[0]?.medium).toBe(2);
  });

  it('should not mutate input rows', () => {
    const rows = [
      { id: '1', mediumNo: 2, position: 1, title: 'B', artistCredit: [], lengthMs: 100000, recordingMbid: null, trackMbid: null },
      { id: '2', mediumNo: 1, position: 1, title: 'A', artistCredit: [], lengthMs: 100000, recordingMbid: null, trackMbid: null },
    ];
    const originalOrder = [rows[0], rows[1]];

    canonicalTrackViews(rows);

    expect(rows).toEqual(originalOrder);
  });
});

describe('planTrackLinks', () => {
  // Enslaved, Vertebrae: the release's eight tracks (seconds), and a folder
  // holding those eight plus eight tracks of other albums.
  const RELEASE: Array<[string, number]> = [
    ['Clouds', 368], ['To the Coast', 387], ['Ground', 397], ['Vertebrae', 300],
    ['New Dawn', 322], ['Reflection', 464], ['Center', 452], ['The Watcher', 251],
  ];
  const OTHERS: Array<[string, number]> = [
    ['Isa', 250], ['Lunar Force', 359], ['Ruun', 425], ['Fusion of Sense and Earth', 412],
    ['Return to Yggdrasill', 401], ['Path to Vanir', 336], ['Bounded by Allegiance', 381], ['Heir to the Cosmic Seed', 492],
  ];
  const canonicalRows = RELEASE.map(([title, s], i) => ({
    id: `ct-${i + 1}`, mediumNo: 1, position: i + 1, title, artistCredit: [], lengthMs: s * 1000, recordingMbid: null, trackMbid: null,
  }));
  const localRows = [
    ...RELEASE.map(([title, s], i) => ({ id: `lt-${title}`, discNo: 1, trackNo: i + 1, titleGuess: title, artistGuess: 'Enslaved', durationMs: s * 1000 + 400 })),
    ...OTHERS.map(([title, s], i) => ({ id: `lt-${title}`, discNo: 1, trackNo: i + 1, titleGuess: title, artistGuess: 'Enslaved', durationMs: s * 1000 })),
  ];
  const titleOf = new Map(canonicalRows.map((c) => [c.id, c.title]));

  /** deterministic shuffle (the order a heap scan might return) */
  const shuffled = <T,>(xs: T[], seed: number): T[] => {
    const out = [...xs];
    let s = seed;
    for (let i = out.length - 1; i > 0; i--) {
      s = (s * 1103515245 + 12345) % 2147483648;
      const j = s % (i + 1);
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  };

  it.each([1, 7, 42, 1234])('links each file to the release track with its own title (rows shuffled, seed %i)', (seed) => {
    const links = planTrackLinks(shuffled(localRows, seed), shuffled(canonicalRows, seed + 1));
    expect(links).toHaveLength(16);
    const byId = new Map(links.map((l) => [l.id, l]));
    for (const [title] of RELEASE) {
      const l = byId.get(`lt-${title}`)!;
      expect(l.state).toBe('matched');
      expect(titleOf.get(l.canonicalTrackId!)).toBe(title);
      expect(l.distance).toBeLessThan(0.01);
    }
    for (const [title] of OTHERS) {
      expect(byId.get(`lt-${title}`)).toMatchObject({ state: 'unmatched', canonicalTrackId: null });
    }
  });

  it('gives every row exactly one entry', () => {
    const links = planTrackLinks(shuffled(localRows, 3), canonicalRows);
    expect(new Set(links.map((l) => l.id)).size).toBe(localRows.length);
  });

  it('pairs multi-disc rows returned out of order', () => {
    const can = [
      { id: 'c11', mediumNo: 1, position: 1, title: 'One', artistCredit: [], lengthMs: 200_000, recordingMbid: null, trackMbid: null },
      { id: 'c12', mediumNo: 1, position: 2, title: 'Two', artistCredit: [], lengthMs: 240_000, recordingMbid: null, trackMbid: null },
      { id: 'c21', mediumNo: 2, position: 1, title: 'Three', artistCredit: [], lengthMs: 180_000, recordingMbid: null, trackMbid: null },
      { id: 'c22', mediumNo: 2, position: 2, title: 'Four', artistCredit: [], lengthMs: 300_000, recordingMbid: null, trackMbid: null },
    ];
    const loc = [
      { id: 'l22', discNo: 2, trackNo: 2, titleGuess: 'Four', artistGuess: null, durationMs: 300_000 },
      { id: 'l11', discNo: 1, trackNo: 1, titleGuess: 'One', artistGuess: null, durationMs: 200_000 },
      { id: 'l21', discNo: 2, trackNo: 1, titleGuess: 'Three', artistGuess: null, durationMs: 180_000 },
      { id: 'l12', discNo: 1, trackNo: 2, titleGuess: 'Two', artistGuess: null, durationMs: 240_000 },
    ];
    const got = Object.fromEntries(planTrackLinks(loc, [can[3]!, can[0]!, can[2]!, can[1]!]).map((l) => [l.id, l.canonicalTrackId]));
    expect(got).toEqual({ l11: 'c11', l12: 'c12', l21: 'c21', l22: 'c22' });
  });
});
