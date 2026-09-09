/**
 * Pure unit tests for track linking helpers (0026).
 * Tests localTrackViews and canonicalTrackViews without a database.
 */

import { describe, it, expect } from 'vitest';
import { localTrackViews, canonicalTrackViews } from './trackLinks.js';

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
