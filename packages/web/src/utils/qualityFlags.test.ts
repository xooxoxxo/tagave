import { describe, expect, it } from 'vitest';
import { describeQualityFlags, parseTrackNumberIssues, shortList, trackList, type QualityIssue } from './qualityFlags';

const byKey = (rows: QualityIssue[], key: string): QualityIssue => {
  const row = rows.find((r) => r.key === key);
  if (!row) throw new Error(`no row for ${key}`);
  return row;
};

const text = (r: QualityIssue) => [r.title, r.count, r.explain, ...(r.affected ?? []), r.guidance].filter(Boolean).join(' | ');

describe('describeQualityFlags', () => {
  it('handles the shapes the worker stores for a real album', () => {
    // copied from a production quality gap (details.flags)
    const flags = {
      noCover: true,
      lowBitrate: 14,
      missingMbIds: { missing: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13] },
      noEmbeddedArt: true,
      trackNumberIssues: {
        issues: [
          'missing tracknumber at track index 0',
          'missing tracknumber at track index 1',
          'missing tracknumber at track index 10',
          'missing tracknumber at track index 2',
        ],
      },
      emptyRequiredFields: { tracks: [0, 1, 2, 10] },
    };
    const rows = describeQualityFlags(flags);
    expect(rows.map((r) => r.key)).toEqual(Object.keys(flags));

    const mb = byKey(rows, 'missingMbIds');
    expect(mb.count).toBe('14 tracks');
    expect(mb.affected).toEqual(['Tracks 1, 2, 3, 4, 5, 6, 7, 8 and 6 more']);
    expect(mb.action).toBe('tags');

    const tn = byKey(rows, 'trackNumberIssues');
    expect(tn.count).toBe('4 tracks');
    expect(tn.explain).toBe('4 tracks have no track number, so players may play the album in the wrong order.');
    // sorted numerically, not the lint rule's string order
    expect(tn.affected).toEqual(['No number: Tracks 1, 2, 3 and 11']);

    expect(byKey(rows, 'emptyRequiredFields').affected).toEqual(['Tracks 1, 2, 3 and 11']);
    expect(byKey(rows, 'lowBitrate').count).toBe('14 tracks');
    expect(byKey(rows, 'noCover').action).toBe('art');
    expect(byKey(rows, 'noEmbeddedArt').guidance).toMatch(/cover art above clears this/);
  });

  it('describes repeated track numbers as repeats, not as missing numbers', () => {
    const rows = describeQualityFlags({
      trackNumberIssues: {
        issues: ['duplicate tracknumber 1 at indices 0, 1', 'duplicate tracknumber 2 at indices 2, 3', 'missing tracknumber at track index 4'],
      },
    });
    const tn = byKey(rows, 'trackNumberIssues');
    expect(tn.count).toBe('5 tracks');
    expect(tn.explain).toBe('1 track has no track number and 2 track numbers are used more than once, so players may play the album in the wrong order.');
    expect(tn.affected).toEqual(['No number: Track 5', 'Repeated: number 1 on tracks 1 and 2; number 2 on tracks 3 and 4']);
  });

  it('names the album fields that differ and counts fields, not tracks', () => {
    const one = byKey(describeQualityFlags({ inconsistentAlbumFields: { fields: ['date'] } }), 'inconsistentAlbumFields');
    expect(one.count).toBe('1 field');
    expect(one.explain).toMatch(/^Date is not the same on every track/);

    const two = byKey(describeQualityFlags({ inconsistentAlbumFields: { fields: ['album', 'albumartist'] } }), 'inconsistentAlbumFields');
    expect(two.count).toBe('2 fields');
    expect(two.explain).toMatch(/^Album title and album artist are not the same on every track/);
  });

  it('reads the missing discs from inside the gap object', () => {
    const one = byKey(describeQualityFlags({ discNumberGaps: { gap: { missing: [2] } } }), 'discNumberGaps');
    expect(one.count).toBe('1 missing disc');
    expect(one.explain).toMatch(/^Disc 2 is skipped/);

    const two = byKey(describeQualityFlags({ discNumberGaps: { gap: { missing: [3, 2] } } }), 'discNumberGaps');
    expect(two.count).toBe('2 missing discs');
    expect(two.explain).toMatch(/^Discs 2 and 3 are skipped/);
  });

  it('pluralises single and multiple files and tracks', () => {
    expect(byKey(describeQualityFlags({ parseErrors: 1 }), 'parseErrors').explain).toMatch(/^One file could not be read\. It may be/);
    expect(byKey(describeQualityFlags({ parseErrors: 3 }), 'parseErrors').explain).toMatch(/^3 files could not be read\. They may be/);
    expect(byKey(describeQualityFlags({ lowBitrate: 1 }), 'lowBitrate').explain).toMatch(/^One lossy track is/);
    expect(byKey(describeQualityFlags({ titleCaseAnomalies: { tracks: [4] } }), 'titleCaseAnomalies').affected).toEqual(['Track 5']);
  });

  it('gives every row a button or plain guidance', () => {
    const rows = describeQualityFlags({
      noCover: true,
      noEmbeddedArt: true,
      parseErrors: 2,
      mixedLossless: true,
      lowBitrate: 3,
      missingMbIds: { missing: [0] },
      somethingNew: true,
    });
    for (const r of rows.filter((r) => r.key !== 'somethingNew')) {
      expect(Boolean(r.action || r.guidance), r.key).toBe(true);
    }
    expect(byKey(rows, 'parseErrors').guidance).toMatch(/Re-rip or replace/);
  });

  it('offers the split only when the folder really is mixed', () => {
    expect(byKey(describeQualityFlags({ mixedLossless: true }, { mixed: true }), 'mixedLossless').action).toBe('split');
    const stale = byKey(describeQualityFlags({ mixedLossless: true }, { mixed: false }), 'mixedLossless');
    expect(stale.action).toBeUndefined();
    expect(stale.guidance).toMatch(/Manage this album/);
  });

  it('never renders undefined, NaN or [object Object]', () => {
    const rows = describeQualityFlags({
      missingMbIds: {},
      trackNumberIssues: { issues: ['something else entirely'] },
      inconsistentAlbumFields: { fields: [] },
      discNumberGaps: { gap: null },
      emptyRequiredFields: true,
      somethingNew: 4,
    });
    for (const r of rows) expect(text(r)).not.toMatch(/undefined|NaN|\[object Object\]/);
    expect(byKey(rows, 'trackNumberIssues').count).toBe('1 issue');
    expect(byKey(rows, 'somethingNew').title).toBe('Something New');
  });

  it('skips empty flags and missing input', () => {
    expect(describeQualityFlags(undefined)).toEqual([]);
    expect(describeQualityFlags({ noCover: false, parseErrors: 0, lowBitrate: null })).toEqual([]);
  });
});

describe('list helpers', () => {
  it('shortens long lists', () => {
    expect(shortList(['a'])).toBe('a');
    expect(shortList(['a', 'b'])).toBe('a and b');
    expect(shortList(['a', 'b', 'c', 'd'], 2)).toBe('a, b and 2 more');
    expect(trackList([2, 0, 0])).toBe('Tracks 1 and 3');
  });

  it('parses the lint rule track number strings', () => {
    expect(parseTrackNumberIssues(['duplicate tracknumber 32 at indices 8, 9, 10', 'missing tracknumber at track index 0'])).toEqual({
      missing: [0],
      duplicates: [{ number: 32, tracks: [8, 9, 10] }],
      other: [],
    });
  });
});
