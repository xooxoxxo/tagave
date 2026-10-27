import { describe, it, expect } from 'vitest';
import type { IAudioMetadata } from 'music-metadata';
import { coreTagsDigest, noNul, tagSnapshotOf } from './audioMetadata.js';

describe('tagSnapshotOf strips NUL everywhere Postgres would reject it', () => {
  it('drops \\u0000 from values, object keys, native tag types and frame ids', () => {
    const meta = {
      common: { title: 'So\u0000ng', 'odd\u0000key': 'v', nested: { 'k\u0000': ['a\u0000'] } },
      native: { 'vorbis\u0000': [{ id: 'TI\u0000TLE', value: { 'x\u0000': 'y\u0000' } }] },
      format: {},
    } as unknown as IAudioMetadata;
    const snap = tagSnapshotOf(meta);
    expect(JSON.stringify(snap)).not.toContain('\\u0000');
    expect(snap.common).toEqual({ title: 'Song', oddkey: 'v', nested: { k: ['a'] } });
    expect(snap.native).toEqual({ vorbis: [{ id: 'TITLE', value: { x: 'y' } }] });
  });

  it('noNul keeps null and strips strings', () => {
    expect(noNul('FL\u0000AC')).toBe('FLAC');
    expect(noNul(undefined)).toBeNull();
  });
});

describe('coreTagsDigest', () => {
  const common = { artist: 'Artist', albumartist: 'Artist', album: 'Album One', title: 'Song', track: { no: 3, of: 9 }, disk: { no: 1, of: 1 }, date: '2001-05-04', musicbrainz_recordingid: 'rec-1' };
  it('keeps the v:1 format: digests stored before it moved to core stay valid', () => {
    expect(coreTagsDigest({ common })).toBe('6da49d24661d37883a4e2cded18b01c4cc04d76d');
  });
  it('ignores case, spacing, NFC/NFD, key order and the full date', () => {
    const a = coreTagsDigest({ common });
    expect(a).toMatch(/^[0-9a-f]{40}$/);
    expect(coreTagsDigest({ common: { ...common, title: '  SONG ', date: '2001' } })).toBe(a);
    expect(coreTagsDigest({ common: { ...common, album: 'Album One'.normalize('NFD') } })).toBe(a);
    expect(coreTagsDigest({ native: {}, common: Object.fromEntries(Object.entries(common).reverse()) })).toBe(a);
  });
  it('changes with any core field', () => {
    const a = coreTagsDigest({ common });
    expect(coreTagsDigest({ common: { ...common, track: { no: 4, of: 9 } } })).not.toBe(a);
    expect(coreTagsDigest({ common: { ...common, musicbrainz_recordingid: 'rec-2' } })).not.toBe(a);
  });
  it('ignores non-core fields and is null for an untagged file', () => {
    expect(coreTagsDigest({ common: { ...common, comment: ['ripped by x'], genre: ['Rock'] } })).toBe(coreTagsDigest({ common }));
    expect(coreTagsDigest({ common: {} })).toBeNull();
    expect(coreTagsDigest(null)).toBeNull();
  });
  it('applies one year rule to year and date', () => {
    const { date: _d, ...noDate } = common;
    expect(coreTagsDigest({ common: { ...noDate, date: '1850-01-01' } })).toBe(coreTagsDigest({ common: { ...noDate, year: 1850 } }));
    expect(coreTagsDigest({ common: { ...noDate, year: 2001 } })).toBe(coreTagsDigest({ common: { ...noDate, date: '2001-05-04' } }));
    expect(coreTagsDigest({ common: { ...noDate, year: '2001' } })).toBe(coreTagsDigest({ common: { ...noDate, year: 2001 } }));
    expect(coreTagsDigest({ common: { ...noDate, year: 99999 } })).toBe(coreTagsDigest({ common: noDate }));
    expect(coreTagsDigest({ common: { ...noDate, year: 99999 } })).not.toBe(coreTagsDigest({ common: { ...noDate, year: 2001 } }));
  });
  it('folds MBID case, multi-value order and zero-padded track numbers', () => {
    expect(coreTagsDigest({ common: { ...common, musicbrainz_recordingid: 'REC-1' } })).toBe(coreTagsDigest({ common }));
    expect(coreTagsDigest({ common: { ...common, artist: ['A', 'B'] } })).toBe(coreTagsDigest({ common: { ...common, artist: ['B', 'A'] } }));
    expect(coreTagsDigest({ common: { ...common, track: { no: '01', of: 9 } } })).toBe(coreTagsDigest({ common: { ...common, track: { no: 1, of: 9 } } }));
  });
  it('maps objects and non-finite numbers to empty', () => {
    expect(coreTagsDigest({ common: { ...common, album: { x: 1 } } })).toBe(coreTagsDigest({ common: { ...common, album: '' } }));
    expect(coreTagsDigest({ common: { ...common, title: Number.NaN } })).toBe(coreTagsDigest({ common: { ...common, title: '' } }));
  });
});
