/**
 * Tests for resolveFields: pure field resolution logic.
 *
 * Covers lock precedence (ENR-5), fallback to release-group fields,
 * null/undefined handling, and all 32 canonical fields.
 */

import { describe, it, expect } from 'vitest';
import { resolveFields, type ResolutionInput, type FieldLock } from './resolveFields.js';
import type { EffectiveGenres } from '../genres/index.js';

describe('resolveFields', () => {
  const mockRelease: ResolutionInput['release'] = {
    title: 'Test Album',
    date: '2020-01-15',
    trackCount: 10,
    barcode: '1234567890123',
    country: 'US',
    status: 'Official',
    labels: [{ name: 'Test Label', catalogNumber: 'TESTCAT001' }],
    media: [{ format: 'CD' }],
    mbid: '550e8400-e29b-41d4-a716-446655440000',
    discogsReleaseId: 12345,
    artists: [{ name: 'Album Artist', mbid: '550e8400-e29b-41d4-a716-446655440005' }],
  };

  const mockReleaseGroup: ResolutionInput['releaseGroup'] = {
    title: 'Test Album',
    primaryType: 'Album',
    firstReleaseDate: '2019-06-01',
    mbid: '550e8400-e29b-41d4-a716-446655440001',
    discogsMasterId: 54321,
    secondaryTypes: [],
    artistCredit: [{ name: 'Test Artist', mbid: '550e8400-e29b-41d4-a716-446655440002' }],
  };

  const mockTrack: ResolutionInput['track'] = {
    title: 'Test Track',
    number: '5',
    position: 5,
    mediumNo: 1,
    mbid: '550e8400-e29b-41d4-a716-446655440003',
    trackMbid: '550e8400-e29b-41d4-a716-446655440099',
    artistCredit: [{ name: 'Track Artist', mbid: '550e8400-e29b-41d4-a716-446655440004' }],
    isrc: 'USTEST1234567',
  };

  const mockArtistCredits: ResolutionInput['artistCredits'] = [
    { name: 'Album Artist', joinPhrase: '', mbid: '550e8400-e29b-41d4-a716-446655440005' },
  ];

  const mockEffectiveGenres: EffectiveGenres = {
    genres: ['Rock', 'Pop'],
    styles: [],
    explain: [],
  };

  it('should resolve all 32 canonical fields from release and track data', () => {
    const input: ResolutionInput = {
      release: mockRelease,
      releaseGroup: mockReleaseGroup,
      track: mockTrack,
      artistCredits: mockArtistCredits,
      effectiveGenres: mockEffectiveGenres,
    };

    const result = resolveFields(input);

    // Check a sample of fields
    expect(result.title!.value).toBe('Test Track');
    expect(result.title!.source).toBe('canonical');

    expect(result.album!.value).toBe('Test Album');
    expect(result.date!.value).toBe('2020-01-15');
    expect(result.tracknumber!.value).toBe('5');
    expect(result.genre!.value).toEqual(['Rock', 'Pop']);

    // Check that no null values are in the result
    for (const field of Object.values(result)) {
      if (field && field.value !== undefined) {
        expect(field.value).not.toBeNull();
      }
    }
  });

  it('should apply file-scope lock and exclude locked field from canonical proposal', () => {
    const locks: FieldLock[] = [
      {
        field: 'genre',
        value: undefined,
        scope: 'file',
        createdAt: new Date(),
        reason: 'User locked genre',
      },
    ];

    const input: ResolutionInput = {
      release: mockRelease,
      releaseGroup: mockReleaseGroup,
      track: mockTrack,
      artistCredits: mockArtistCredits,
      effectiveGenres: mockEffectiveGenres,
      locks,
    };

    const result = resolveFields(input);

    expect(result.genre!.source).toBe('lock');
    expect(result.genre!.value).toBeUndefined();
    expect(result.genre!.reason).toContain('locked');

    // Other fields should still be resolved from canonical data
    expect(result.title!.source).toBe('canonical');
    expect(result.album!.source).toBe('canonical');
  });

  it('should apply album-scope lock to suppress field value', () => {
    const locks: FieldLock[] = [
      {
        field: 'genre',
        value: [],
        scope: 'album',
        createdAt: new Date(),
        reason: 'User locked album genres',
      },
    ];

    const input: ResolutionInput = {
      release: mockRelease,
      releaseGroup: mockReleaseGroup,
      track: mockTrack,
      artistCredits: mockArtistCredits,
      effectiveGenres: mockEffectiveGenres,
      locks,
    };

    const result = resolveFields(input);

    expect(result.genre!.source).toBe('lock');
    expect(result.genre!.value).toEqual([]);
  });

  it('should give precedence to file-scope lock over album-scope lock', () => {
    const locks: FieldLock[] = [
      {
        field: 'genre',
        value: ['Album Genre'],
        scope: 'album',
        createdAt: new Date(),
      },
      {
        field: 'genre',
        value: ['File Genre'],
        scope: 'file',
        createdAt: new Date(),
      },
    ];

    const input: ResolutionInput = {
      release: mockRelease,
      releaseGroup: mockReleaseGroup,
      track: mockTrack,
      artistCredits: mockArtistCredits,
      locks,
    };

    const result = resolveFields(input);

    expect(result.genre!.source).toBe('lock');
    expect(result.genre!.value).toEqual(['File Genre']);
  });

  it('should fall back to release-group fields when track data is missing', () => {
    const input: ResolutionInput = {
      release: mockRelease,
      releaseGroup: mockReleaseGroup,
      // track is undefined
      artistCredits: mockArtistCredits,
      effectiveGenres: mockEffectiveGenres,
    };

    const result = resolveFields(input);

    // Track title missing, falls back to release group title
    expect(result.title!.value).toBe('Test Album');
    expect(result.title!.reason).toContain('release group');

    // Date from release (track doesn't have date)
    expect(result.date!.value).toBe('2020-01-15');

    // Original date from release group
    expect(result.originaldate!.value).toBe('2019-06-01');
  });

  it('should handle null/undefined values in release without including them in output', () => {
    const input: ResolutionInput = {
      release: {
        title: 'Album',
        // Other fields undefined/null
      },
      releaseGroup: mockReleaseGroup,
      track: mockTrack,
      artistCredits: mockArtistCredits,
      effectiveGenres: mockEffectiveGenres,
    };

    const result = resolveFields(input);

    // album.value should come from release.title
    expect(result.album!.value).toBe('Album');

    // date should be undefined (not in release)
    expect(result.date!.value).toBeUndefined();

    // Verify no null values in the entire result
    for (const [, field] of Object.entries(result)) {
      expect(field.value).not.toBeNull();
    }
  });

  it('should handle missing release and release group gracefully', () => {
    const input: ResolutionInput = {
      // release and releaseGroup both undefined
      track: mockTrack,
      artistCredits: mockArtistCredits,
      effectiveGenres: mockEffectiveGenres,
    };

    const result = resolveFields(input);

    // Should still have a result for each field
    expect(Object.keys(result).length).toBe(32);

    // title should come from track
    expect(result.title!.value).toBe('Test Track');

    // album should be undefined
    expect(result.album!.value).toBeUndefined();
  });

  it('should format artist credits correctly with join phrases', () => {
    const credits = [
      { name: 'Artist A', joinPhrase: ' feat. ' },
      { name: 'Artist B', joinPhrase: ' & ' },
      { name: 'Artist C', joinPhrase: '' },
    ];

    const input: ResolutionInput = {
      artistCredits: credits,
      effectiveGenres: mockEffectiveGenres,
    };

    const result = resolveFields(input);

    expect(result.artist!.value).toContain('Artist A');
    expect(result.artist!.value).toContain('Artist B');
    expect(result.artist!.value).toContain('Artist C');
  });

  it('should extract MusicBrainz artist IDs correctly', () => {
    const credits = [
      { name: 'Artist A', mbid: 'mbid-a' },
      { name: 'Artist B', mbid: 'mbid-b' },
      { name: 'Artist C' }, // no MBID
    ];

    const input: ResolutionInput = {
      artistCredits: credits,
      effectiveGenres: mockEffectiveGenres,
    };

    const result = resolveFields(input);

    expect(Array.isArray(result.musicbrainz_artistid!.value)).toBe(true);
    const mbids = result.musicbrainz_artistid!.value as string[];
    expect(mbids).toContain('mbid-a');
    expect(mbids).toContain('mbid-b');
  });

  it('should format genre with title case', () => {
    const genres: EffectiveGenres = {
      genres: ['rock', 'electronic', 'hip hop'],
      styles: [],
      explain: [],
    };

    const input: ResolutionInput = {
      release: mockRelease,
      releaseGroup: mockReleaseGroup,
      track: mockTrack,
      effectiveGenres: genres,
    };

    const result = resolveFields(input);

    const genreValue = result.genre!.value as string[];
    expect(genreValue).toContain('Rock');
    expect(genreValue).toContain('Electronic');
    expect(genreValue).toContain('Hip Hop');
  });

  it('should handle empty effective genres', () => {
    const input: ResolutionInput = {
      release: mockRelease,
      releaseGroup: mockReleaseGroup,
      track: mockTrack,
      artistCredits: mockArtistCredits,
      effectiveGenres: { genres: [], styles: [], explain: [] },
    };

    const result = resolveFields(input);

    expect(result.genre!.value).toBeUndefined();
    expect(result.genre!.reason).toContain('no genres');
  });

  it('should resolve Discogs IDs correctly', () => {
    const input: ResolutionInput = {
      release: mockRelease,
      releaseGroup: mockReleaseGroup,
      track: mockTrack,
      effectiveGenres: mockEffectiveGenres,
    };

    const result = resolveFields(input);

    expect(result.discogs_release_id!.value).toBe('12345');
    expect(result.discogs_master_id!.value).toBe('54321');
  });

  it('should handle ISRC as single value or array', () => {
    const inputSingle: ResolutionInput = {
      track: { ...mockTrack, isrc: 'SINGLE1234567' },
      effectiveGenres: mockEffectiveGenres,
    };

    const resultSingle = resolveFields(inputSingle);
    expect(Array.isArray(resultSingle.isrc!.value)).toBe(true);
    expect((resultSingle.isrc!.value as string[])[0]).toBe('SINGLE1234567');

    const inputArray: ResolutionInput = {
      track: { ...mockTrack, isrc: ['ARRAY1', 'ARRAY2'] },
      effectiveGenres: mockEffectiveGenres,
    };

    const resultArray = resolveFields(inputArray);
    expect(Array.isArray(resultArray.isrc!.value)).toBe(true);
    expect(resultArray.isrc!.value).toEqual(['ARRAY1', 'ARRAY2']);
  });

  it('should identify compilation releases correctly', () => {
    const input: ResolutionInput = {
      releaseGroup: {
        ...mockReleaseGroup,
        primaryType: 'Album',
        secondaryTypes: ['Compilation'],
      },
      track: mockTrack,
      effectiveGenres: mockEffectiveGenres,
    };

    const result = resolveFields(input);

    expect(result.compilation!.value).toBe('1');
  });

  it('should not mark as compilation when not a compilation', () => {
    const input: ResolutionInput = {
      releaseGroup: {
        ...mockReleaseGroup,
        primaryType: 'Album',
        secondaryTypes: [],
      },
      track: mockTrack,
      effectiveGenres: mockEffectiveGenres,
    };

    const result = resolveFields(input);

    expect(result.compilation!.value).toBeUndefined();
  });

  it('should resolve musicbrainz_releasetrackid from track.trackMbid', () => {
    const input: ResolutionInput = {
      release: mockRelease,
      releaseGroup: mockReleaseGroup,
      track: mockTrack,
      artistCredits: mockArtistCredits,
      effectiveGenres: mockEffectiveGenres,
    };

    const result = resolveFields(input);

    expect(result.musicbrainz_releasetrackid!.value).toBe('550e8400-e29b-41d4-a716-446655440099');
    expect(result.musicbrainz_releasetrackid!.reason).toContain('from release track');
  });

  it('should return undefined for musicbrainz_releasetrackid when trackMbid is absent', () => {
    const { trackMbid: _, ...trackWithoutMbid } = mockTrack;
    const input: ResolutionInput = {
      release: mockRelease,
      releaseGroup: mockReleaseGroup,
      track: trackWithoutMbid,
      artistCredits: mockArtistCredits,
      effectiveGenres: mockEffectiveGenres,
    };

    const result = resolveFields(input);

    expect(result.musicbrainz_releasetrackid!.value).toBeUndefined();
    expect(result.musicbrainz_releasetrackid!.reason).toContain('no MusicBrainz release track ID available');
  });

  it('should resolve musicbrainz_recordingid from track.mbid independently', () => {
    const input: ResolutionInput = {
      release: mockRelease,
      releaseGroup: mockReleaseGroup,
      track: mockTrack,
      artistCredits: mockArtistCredits,
      effectiveGenres: mockEffectiveGenres,
    };

    const result = resolveFields(input);

    expect(result.musicbrainz_recordingid!.value).toBe('550e8400-e29b-41d4-a716-446655440003');
    expect(result.musicbrainz_releasetrackid!.value).toBe('550e8400-e29b-41d4-a716-446655440099');
    // Both should be present and different
    expect(result.musicbrainz_recordingid!.value).not.toEqual(result.musicbrainz_releasetrackid!.value);
  });
});
