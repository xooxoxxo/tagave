import { describe, it, expect } from 'vitest';
import { lintAlbum } from '@liner/core';
import { currentFieldsFrom, rawTracksForLint } from './canonicalTags.js';

// The shape scanParse stores: music-metadata's common block under `common`.
const scanned = (common: Record<string, unknown>) => ({ common, native: {} });

describe('currentFieldsFrom', () => {
  it('maps music-metadata common to canonical fields', () => {
    const f = currentFieldsFrom(scanned({
      title: 'Jonestown', artist: 'A Challenge of Honour', album: 'Only Stones Remain',
      track: { no: 2, of: 11 }, disk: { no: 1, of: null }, genre: ['Electronic'],
      musicbrainz_albumid: 'd426a5c2-60ac-451f-ba6b-c5ec1891ed98',
      musicbrainz_trackid: 'rt-1', year: 1994,
    }));
    expect(f.tracknumber).toBe('2');
    expect(f.totaltracks).toBe('11');
    expect(f.discnumber).toBe('1');
    expect(f.totaldiscs).toBeNull();
    expect(f.date).toBe('1994');
    expect(f.genre).toEqual(['Electronic']);
    expect(f.musicbrainz_releasetrackid).toBe('rt-1');
  });

  it('treats a flattened or empty snapshot as no tags', () => {
    expect(currentFieldsFrom({ title: 'x' }).title).toBeNull();
    expect(currentFieldsFrom(null).title).toBeNull();
  });
});

describe('rawTracksForLint', () => {
  const full = (n: number) => scanned({
    title: `Track ${n}`, artist: 'Artist', album: 'Album', track: { no: n, of: 2 },
    musicbrainz_recordingid: `rec-${n}`,
  });

  it('drops nulls so the lint sees only present fields', () => {
    const [t] = rawTracksForLint([scanned({ title: 'Only title' })]);
    expect(t).toEqual({ title: 'Only title' });
  });

  it('does not flag required fields or track numbers on a fully tagged album', () => {
    const flags = lintAlbum(rawTracksForLint([full(1), full(2)]), {}, true).map((f) => f.rule);
    expect(flags).not.toContain('emptyRequiredFields');
    expect(flags).not.toContain('trackNumberIssues');
    expect(flags).not.toContain('missingMbIds');
  });

  it('still flags an album whose files carry no track numbers', () => {
    const bare = (n: number) => scanned({ title: `Track ${n}`, artist: 'Artist', album: 'Album' });
    const flags = lintAlbum(rawTracksForLint([bare(1), bare(2)]), {}, true).map((f) => f.rule);
    expect(flags).toContain('emptyRequiredFields');
    expect(flags).toContain('missingMbIds');
  });
});
