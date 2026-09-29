import { describe, it, expect } from 'vitest';
import { displayArtistName, isVariousArtists, leadingNumberOf, stripTrackNumberPrefix, manualTagValuesSchema } from '@liner/shared';
import { bulkTagsFrom, suggestBulkValues, type BulkFileTags } from './bulkTagEdit.js';
import { mergedArtistGuess, mergedOriginalKey, isMergedKey } from './mergeAlbums.js';

const file = (over: Partial<BulkFileTags>): BulkFileTags => ({
  albumartist: null, album: null, artist: null, date: null, genre: [], compilation: false, trackNo: null, ...over,
});

describe('artist names', () => {
  it('strips a baked-in track number only when it is the track number', () => {
    expect(stripTrackNumberPrefix('02. Stephane Pompougnac', 2)).toBe('Stephane Pompougnac');
    expect(stripTrackNumberPrefix('02. Stephane Pompougnac', 3)).toBe('02. Stephane Pompougnac');
    expect(stripTrackNumberPrefix('02. Stephane Pompougnac', null)).toBe('02. Stephane Pompougnac');
    expect(stripTrackNumberPrefix('02. Stephane Pompougnac')).toBe('Stephane Pompougnac');
    expect(stripTrackNumberPrefix('808 State', 8)).toBe('808 State');
    expect(stripTrackNumberPrefix('2Pac', 2)).toBe('2Pac');
    expect(leadingNumberOf('17. Eden')).toBe(17);
    expect(leadingNumberOf('Eden')).toBeNull();
  });

  it('folds VA spellings and numbering for display', () => {
    for (const va of ['Various', 'VA', 'V.A.', 'various artists', ' Various Artists ']) expect(isVariousArtists(va)).toBe(true);
    expect(isVariousArtists('Various Cruelties')).toBe(false);
    expect(displayArtistName('Various')).toBe('Various Artists');
    expect(displayArtistName('05. Stephane Pompougnac')).toBe('Stephane Pompougnac');
    expect(displayArtistName('  ')).toBeNull();
    expect(displayArtistName(null)).toBeNull();
    expect(displayArtistName('Radiohead')).toBe('Radiohead');
  });
});

describe('suggestBulkValues', () => {
  it('Hotel Costes: stripped album artist, shared title and year, a compilation', () => {
    const files = [
      file({ albumartist: '01. Stephane Pompougnac', artist: 'Lena Horne', album: 'Hotel Costes Vol. 11', date: '2008', trackNo: 1 }),
      file({ albumartist: '02. Stephane Pompougnac', artist: 'Morten Varano', album: 'Hotel Costes Vol. 11', date: '2008', trackNo: 2 }),
      file({ albumartist: '03. Stephane Pompougnac', artist: 'Vanessa Da Mata', album: 'Hotel Costes Vol. 11', date: '2008', trackNo: 3 }),
    ];
    const s = suggestBulkValues(files, 3);
    expect(s.suggested).toEqual({ albumartist: 'Stephane Pompougnac', album: 'Hotel Costes Vol. 11', date: '2008', compilation: '1' });
    expect(s.numberedAlbumArtists).toBe(3);
    expect(s.trackArtistsDiffer).toBe(true);
    expect(s.albumArtistOptions).toEqual(['Various Artists']);
    expect(s.notes.join(' ')).toMatch(/track number/);
    expect(s.current.albumartist).toHaveLength(3);
  });

  it('per-track album artists that differ: Various Artists', () => {
    const s = suggestBulkValues([
      file({ albumartist: 'A', artist: 'A', album: 'Mix' }),
      file({ albumartist: 'B', artist: 'B', album: 'Mix' }),
    ], 2);
    expect(s.suggested.albumartist).toBe('Various Artists');
    expect(s.suggested.compilation).toBe('1');
    expect(s.albumArtistOptions).toEqual(expect.arrayContaining(['A', 'B']));
  });

  it('one artist throughout: no compilation, the artist as album artist', () => {
    const s = suggestBulkValues([
      file({ artist: 'Portishead', album: 'Dummy', genre: ['Trip Hop'] }),
      file({ artist: 'Portishead', album: 'Dummy', genre: ['Trip Hop'] }),
    ], 1);
    expect(s.suggested).toEqual({ albumartist: 'Portishead', album: 'Dummy', genre: ['Trip Hop'] });
  });

  it('never suggests a date the files disagree on', () => {
    const s = suggestBulkValues([file({ date: '1999' }), file({ date: '2004-01-01' })], 1);
    expect(s.suggested.date).toBeUndefined();
    expect(suggestBulkValues([file({ date: '2004-01-01' }), file({ date: '2004' })], 1).suggested.date).toBe('2004-01-01');
  });

  it('reads the music-metadata snapshot', () => {
    expect(bulkTagsFrom({ common: { albumartist: '02. X', artist: 'Y', album: 'Z', year: 2008, genre: ['Lounge'], compilation: true, track: { no: 2 } } }, null))
      .toEqual({ albumartist: '02. X', album: 'Z', artist: 'Y', date: '2008', genre: ['Lounge'], compilation: true, trackNo: 2 });
    expect(bulkTagsFrom(null, 4)).toMatchObject({ albumartist: null, genre: [], trackNo: 4 });
  });
});

describe('manual values schema', () => {
  it('accepts album-level values and rejects junk', () => {
    expect(manualTagValuesSchema.safeParse({ albumartist: 'Various Artists', compilation: '1', date: '2008' }).success).toBe(true);
    expect(manualTagValuesSchema.safeParse({ date: '08' }).success).toBe(false);
    expect(manualTagValuesSchema.safeParse({ compilation: 'yes' }).success).toBe(false);
    expect(manualTagValuesSchema.safeParse({ title: 'x' }).success).toBe(false);
    expect(manualTagValuesSchema.safeParse({ albumartist: '   ' }).success).toBe(false);
  });
});

describe('merge helpers', () => {
  it('merged artist: agreed album artist, else Various Artists when track artists differ', () => {
    expect(mergedArtistGuess([
      { artist: 'Lena Horne', albumartist: '01. Stephane Pompougnac', trackNo: 1 },
      { artist: 'Shazz', albumartist: '07. Stephane Pompougnac', trackNo: 7 },
    ], null)).toBe('Stephane Pompougnac');
    expect(mergedArtistGuess([{ artist: 'A' }, { artist: 'B' }], 'A')).toBe('Various Artists');
    expect(mergedArtistGuess([{ artist: 'A' }, { artist: 'a' }], null)).toBe('A');
    expect(mergedArtistGuess([{ artist: null }], '03. Name')).toBe('Name');
  });

  it('merge keys remember the original', () => {
    expect(isMergedKey('merge:abc')).toBe(true);
    expect(mergedOriginalKey('merge:abc')).toBe('abc');
    expect(mergedOriginalKey('abc')).toBeNull();
    expect(mergedOriginalKey(null)).toBeNull();
  });
});
