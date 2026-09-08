import { describe, it, expect } from 'vitest';
import { lintAlbum, type RawTrackTags, type LintToggles } from './lintRules.js';

describe('lintAlbum', () => {
  it('returns empty array for clean album', () => {
    const tracks: RawTrackTags[] = [
      {
        title: 'Track One',
        artist: 'Artist A',
        album: 'Album Title',
        albumartist: 'Album Artist',
        date: '2020-01-01',
        tracknumber: '1',
        totaltracks: '3',
        discnumber: '1',
        musicbrainz_recordingid: 'rec-1',
      },
      {
        title: 'Track Two',
        artist: 'Artist A',
        album: 'Album Title',
        albumartist: 'Album Artist',
        date: '2020-01-01',
        tracknumber: '2',
        totaltracks: '3',
        discnumber: '1',
        musicbrainz_recordingid: 'rec-2',
      },
      {
        title: 'Track Three',
        artist: 'Artist A',
        album: 'Album Title',
        albumartist: 'Album Artist',
        date: '2020-01-01',
        tracknumber: '3',
        totaltracks: '3',
        discnumber: '1',
        musicbrainz_recordingid: 'rec-3',
      },
    ];

    const flags = lintAlbum(tracks);
    expect(flags).toEqual([]);
  });

  it('detects inconsistent album fields', () => {
    const tracks: RawTrackTags[] = [
      {
        title: 'Track One',
        artist: 'Artist A',
        album: 'Album Title',
        albumartist: 'Album Artist',
        date: '2020-01-01',
        tracknumber: '1',
        musicbrainz_recordingid: 'rec-1',
      },
      {
        title: 'Track Two',
        artist: 'Artist A',
        album: 'Different Album',
        albumartist: 'Album Artist',
        date: '2020-01-01',
        tracknumber: '2',
        musicbrainz_recordingid: 'rec-2',
      },
    ];

    const flags = lintAlbum(tracks);
    const flag = flags.find((f) => f.rule === 'inconsistentAlbumFields');
    expect(flag).toBeDefined();
    expect(flag?.details?.fields).toContain('album');
  });

  it('detects inconsistent albumartist', () => {
    const tracks: RawTrackTags[] = [
      {
        title: 'Track One',
        artist: 'Artist A',
        album: 'Album Title',
        albumartist: 'Album Artist 1',
        date: '2020-01-01',
        tracknumber: '1',
        musicbrainz_recordingid: 'rec-1',
      },
      {
        title: 'Track Two',
        artist: 'Artist A',
        album: 'Album Title',
        albumartist: 'Album Artist 2',
        date: '2020-01-01',
        tracknumber: '2',
        musicbrainz_recordingid: 'rec-2',
      },
    ];

    const flags = lintAlbum(tracks);
    const flag = flags.find((f) => f.rule === 'inconsistentAlbumFields');
    expect(flag).toBeDefined();
    expect(flag?.details?.fields).toContain('albumartist');
  });

  it('detects inconsistent date', () => {
    const tracks: RawTrackTags[] = [
      {
        title: 'Track One',
        artist: 'Artist A',
        album: 'Album Title',
        albumartist: 'Album Artist',
        date: '2020-01-01',
        tracknumber: '1',
        musicbrainz_recordingid: 'rec-1',
      },
      {
        title: 'Track Two',
        artist: 'Artist A',
        album: 'Album Title',
        albumartist: 'Album Artist',
        date: '2021-06-15',
        tracknumber: '2',
        musicbrainz_recordingid: 'rec-2',
      },
    ];

    const flags = lintAlbum(tracks);
    const flag = flags.find((f) => f.rule === 'inconsistentAlbumFields');
    expect(flag).toBeDefined();
    expect(flag?.details?.fields).toContain('date');
  });

  it('detects inconsistent totaltracks', () => {
    const tracks: RawTrackTags[] = [
      {
        title: 'Track One',
        artist: 'Artist A',
        album: 'Album Title',
        albumartist: 'Album Artist',
        date: '2020-01-01',
        tracknumber: '1',
        totaltracks: '3',
        musicbrainz_recordingid: 'rec-1',
      },
      {
        title: 'Track Two',
        artist: 'Artist A',
        album: 'Album Title',
        albumartist: 'Album Artist',
        date: '2020-01-01',
        tracknumber: '2',
        totaltracks: '2',
        musicbrainz_recordingid: 'rec-2',
      },
    ];

    const flags = lintAlbum(tracks);
    const flag = flags.find((f) => f.rule === 'inconsistentAlbumFields');
    expect(flag).toBeDefined();
    expect(flag?.details?.fields).toContain('totaltracks');
  });

  it('detects missing MusicBrainz IDs', () => {
    const tracks: RawTrackTags[] = [
      {
        title: 'Track One',
        artist: 'Artist A',
        album: 'Album Title',
        tracknumber: '1',
        musicbrainz_recordingid: 'rec-1',
      },
      {
        title: 'Track Two',
        artist: 'Artist A',
        album: 'Album Title',
        tracknumber: '2',
        // Missing both recording and release-track IDs
      },
    ];

    const flags = lintAlbum(tracks);
    const flag = flags.find((f) => f.rule === 'missingMbIds');
    expect(flag).toBeDefined();
    const details = flag?.details as { missing?: number[] } | undefined;
    expect(details?.missing).toContain(1);
  });

  it('detects missing track numbers', () => {
    const tracks: RawTrackTags[] = [
      {
        title: 'Track One',
        artist: 'Artist A',
        album: 'Album Title',
        tracknumber: '1',
        musicbrainz_recordingid: 'rec-1',
      },
      {
        title: 'Track Two',
        artist: 'Artist A',
        album: 'Album Title',
        // Missing tracknumber
        musicbrainz_recordingid: 'rec-2',
      },
    ];

    const flags = lintAlbum(tracks);
    const flag = flags.find((f) => f.rule === 'trackNumberIssues');
    expect(flag).toBeDefined();
    expect(flag?.details?.issues).toContainEqual(expect.stringContaining('missing tracknumber'));
  });

  it('detects duplicate track numbers', () => {
    const tracks: RawTrackTags[] = [
      {
        title: 'Track One',
        artist: 'Artist A',
        album: 'Album Title',
        tracknumber: '1',
        musicbrainz_recordingid: 'rec-1',
      },
      {
        title: 'Track One Again',
        artist: 'Artist A',
        album: 'Album Title',
        tracknumber: '1',
        musicbrainz_recordingid: 'rec-1-dup',
      },
    ];

    const flags = lintAlbum(tracks);
    const flag = flags.find((f) => f.rule === 'trackNumberIssues');
    expect(flag).toBeDefined();
    expect(flag?.details?.issues).toContainEqual(expect.stringContaining('duplicate tracknumber'));
  });

  it('detects title case anomalies (all lowercase)', () => {
    const tracks: RawTrackTags[] = [
      {
        title: 'track one',
        artist: 'Artist A',
        album: 'Album Title',
        tracknumber: '1',
        musicbrainz_recordingid: 'rec-1',
      },
      {
        title: 'Track Two',
        artist: 'Artist A',
        album: 'Album Title',
        tracknumber: '2',
        musicbrainz_recordingid: 'rec-2',
      },
    ];

    const flags = lintAlbum(tracks);
    const flag = flags.find((f) => f.rule === 'titleCaseAnomalies');
    expect(flag).toBeDefined();
    expect(flag?.details?.tracks).toContain(0);
  });

  it('detects title case anomalies (all uppercase)', () => {
    const tracks: RawTrackTags[] = [
      {
        title: 'TRACK ONE',
        artist: 'Artist A',
        album: 'Album Title',
        tracknumber: '1',
        musicbrainz_recordingid: 'rec-1',
      },
      {
        title: 'Track Two',
        artist: 'Artist A',
        album: 'Album Title',
        tracknumber: '2',
        musicbrainz_recordingid: 'rec-2',
      },
    ];

    const flags = lintAlbum(tracks);
    const flag = flags.find((f) => f.rule === 'titleCaseAnomalies');
    expect(flag).toBeDefined();
    expect(flag?.details?.tracks).toContain(0);
  });

  it('detects empty required fields (missing title)', () => {
    const tracks: RawTrackTags[] = [
      {
        // Missing title
        artist: 'Artist A',
        album: 'Album Title',
        tracknumber: '1',
        musicbrainz_recordingid: 'rec-1',
      },
      {
        title: 'Track Two',
        artist: 'Artist A',
        album: 'Album Title',
        tracknumber: '2',
        musicbrainz_recordingid: 'rec-2',
      },
    ];

    const flags = lintAlbum(tracks);
    const flag = flags.find((f) => f.rule === 'emptyRequiredFields');
    expect(flag).toBeDefined();
    expect(flag?.details?.tracks).toContain(0);
  });

  it('detects empty required fields (missing artist)', () => {
    const tracks: RawTrackTags[] = [
      {
        title: 'Track One',
        // Missing artist
        album: 'Album Title',
        tracknumber: '1',
        musicbrainz_recordingid: 'rec-1',
      },
    ];

    const flags = lintAlbum(tracks);
    const flag = flags.find((f) => f.rule === 'emptyRequiredFields');
    expect(flag).toBeDefined();
    expect(flag?.details?.tracks).toContain(0);
  });

  it('detects empty required fields (missing album)', () => {
    const tracks: RawTrackTags[] = [
      {
        title: 'Track One',
        artist: 'Artist A',
        // Missing album
        tracknumber: '1',
        musicbrainz_recordingid: 'rec-1',
      },
    ];

    const flags = lintAlbum(tracks);
    const flag = flags.find((f) => f.rule === 'emptyRequiredFields');
    expect(flag).toBeDefined();
    expect(flag?.details?.tracks).toContain(0);
  });

  it('detects disc number gaps', () => {
    const tracks: RawTrackTags[] = [
      {
        title: 'Track One',
        artist: 'Artist A',
        album: 'Album Title',
        tracknumber: '1',
        discnumber: '1',
        musicbrainz_recordingid: 'rec-1',
      },
      {
        title: 'Track Two',
        artist: 'Artist A',
        album: 'Album Title',
        tracknumber: '1',
        discnumber: '3',
        musicbrainz_recordingid: 'rec-2',
      },
    ];

    const flags = lintAlbum(tracks);
    const flag = flags.find((f) => f.rule === 'discNumberGaps');
    expect(flag).toBeDefined();
    const details = flag?.details as { gap?: { missing?: number[] } } | undefined;
    expect(details?.gap?.missing).toContain(2);
  });

  it('detects missing embedded art', () => {
    const tracks: RawTrackTags[] = [
      {
        title: 'Track One',
        artist: 'Artist A',
        album: 'Album Title',
        tracknumber: '1',
        musicbrainz_recordingid: 'rec-1',
      },
    ];

    const flags = lintAlbum(tracks, {}, false);
    const flag = flags.find((f) => f.rule === 'noEmbeddedArt');
    expect(flag).toBeDefined();
  });

  it('does not flag missing embedded art when art is present', () => {
    const tracks: RawTrackTags[] = [
      {
        title: 'Track One',
        artist: 'Artist A',
        album: 'Album Title',
        tracknumber: '1',
        musicbrainz_recordingid: 'rec-1',
      },
    ];

    const flags = lintAlbum(tracks, {}, true);
    const flag = flags.find((f) => f.rule === 'noEmbeddedArt');
    expect(flag).toBeUndefined();
  });

  it('respects toggle for inconsistentAlbumFields', () => {
    const tracks: RawTrackTags[] = [
      {
        title: 'Track One',
        artist: 'Artist A',
        album: 'Album 1',
        tracknumber: '1',
        musicbrainz_recordingid: 'rec-1',
      },
      {
        title: 'Track Two',
        artist: 'Artist A',
        album: 'Album 2',
        tracknumber: '2',
        musicbrainz_recordingid: 'rec-2',
      },
    ];

    const flags = lintAlbum(tracks, { inconsistentAlbumFields: false });
    const flag = flags.find((f) => f.rule === 'inconsistentAlbumFields');
    expect(flag).toBeUndefined();
  });

  it('respects toggle for missingMbIds', () => {
    const tracks: RawTrackTags[] = [
      {
        title: 'Track One',
        artist: 'Artist A',
        album: 'Album Title',
        tracknumber: '1',
        // Missing MB ID
      },
    ];

    const flags = lintAlbum(tracks, { missingMbIds: false });
    const flag = flags.find((f) => f.rule === 'missingMbIds');
    expect(flag).toBeUndefined();
  });

  it('respects toggle for trackNumberIssues', () => {
    const tracks: RawTrackTags[] = [
      {
        title: 'Track One',
        artist: 'Artist A',
        album: 'Album Title',
        // Missing tracknumber
        musicbrainz_recordingid: 'rec-1',
      },
    ];

    const flags = lintAlbum(tracks, { trackNumberIssues: false });
    const flag = flags.find((f) => f.rule === 'trackNumberIssues');
    expect(flag).toBeUndefined();
  });

  it('respects toggle for titleCaseAnomalies', () => {
    const tracks: RawTrackTags[] = [
      {
        title: 'track one lowercase',
        artist: 'Artist A',
        album: 'Album Title',
        tracknumber: '1',
        musicbrainz_recordingid: 'rec-1',
      },
    ];

    const flags = lintAlbum(tracks, { titleCaseAnomalies: false });
    const flag = flags.find((f) => f.rule === 'titleCaseAnomalies');
    expect(flag).toBeUndefined();
  });

  it('respects toggle for emptyRequiredFields', () => {
    const tracks: RawTrackTags[] = [
      {
        // Missing title
        artist: 'Artist A',
        album: 'Album Title',
        tracknumber: '1',
        musicbrainz_recordingid: 'rec-1',
      },
    ];

    const flags = lintAlbum(tracks, { emptyRequiredFields: false });
    const flag = flags.find((f) => f.rule === 'emptyRequiredFields');
    expect(flag).toBeUndefined();
  });

  it('respects toggle for discNumberGaps', () => {
    const tracks: RawTrackTags[] = [
      {
        title: 'Track One',
        artist: 'Artist A',
        album: 'Album Title',
        tracknumber: '1',
        discnumber: '1',
        musicbrainz_recordingid: 'rec-1',
      },
      {
        title: 'Track Two',
        artist: 'Artist A',
        album: 'Album Title',
        tracknumber: '1',
        discnumber: '3',
        musicbrainz_recordingid: 'rec-2',
      },
    ];

    const flags = lintAlbum(tracks, { discNumberGaps: false });
    const flag = flags.find((f) => f.rule === 'discNumberGaps');
    expect(flag).toBeUndefined();
  });

  it('respects toggle for noEmbeddedArt', () => {
    const tracks: RawTrackTags[] = [
      {
        title: 'Track One',
        artist: 'Artist A',
        album: 'Album Title',
        tracknumber: '1',
        musicbrainz_recordingid: 'rec-1',
      },
    ];

    const flags = lintAlbum(tracks, { noEmbeddedArt: false }, false);
    const flag = flags.find((f) => f.rule === 'noEmbeddedArt');
    expect(flag).toBeUndefined();
  });

  it('merges audio flags and tag flags', () => {
    // Simulate that we already have audio flags from GAP-5
    // and then we add tag flags from lintAlbum
    const tracks: RawTrackTags[] = [
      {
        title: 'track one',
        artist: 'Artist A',
        album: 'Album Title',
        tracknumber: '1',
        musicbrainz_recordingid: 'rec-1',
      },
    ];

    const audioFlags = {
      noCover: true,
      lowBitrate: 1,
    };

    const tagFlags = lintAlbum(tracks);

    // Simulate merging as would happen in gapsRecompute
    const mergedFlags: Record<string, unknown> = {
      ...audioFlags,
      ...Object.fromEntries(tagFlags.map((f) => [f.rule, f.details ?? true])),
    };

    expect(mergedFlags.noCover).toBe(true);
    expect(mergedFlags.lowBitrate).toBe(1);
    expect(mergedFlags.titleCaseAnomalies).toBeDefined();
  });

  it('returns flags in deterministic order', () => {
    const tracks: RawTrackTags[] = [
      {
        title: 'track one',
        artist: 'Artist A',
        album: 'Album 1',
        tracknumber: '1',
      },
      {
        title: 'Track Two',
        artist: 'Artist A',
        album: 'Album 2',
        tracknumber: '1',
      },
    ];

    const flags1 = lintAlbum(tracks);
    const flags2 = lintAlbum(tracks);

    expect(flags1.map((f) => f.rule)).toEqual(flags2.map((f) => f.rule));
    expect(flags1.map((f) => f.rule).every((r, i) => i === 0 || r >= flags1[i - 1]!.rule)).toBe(
      true
    );
  });

  it('handles track numbers with /total format', () => {
    const tracks: RawTrackTags[] = [
      {
        title: 'Track One',
        artist: 'Artist A',
        album: 'Album Title',
        tracknumber: '1/3',
        musicbrainz_recordingid: 'rec-1',
      },
      {
        title: 'Track Two',
        artist: 'Artist A',
        album: 'Album Title',
        tracknumber: '2/3',
        musicbrainz_recordingid: 'rec-2',
      },
      {
        title: 'Track Three',
        artist: 'Artist A',
        album: 'Album Title',
        tracknumber: '3/3',
        musicbrainz_recordingid: 'rec-3',
      },
    ];

    const flags = lintAlbum(tracks);
    const flag = flags.find((f) => f.rule === 'trackNumberIssues');
    expect(flag).toBeUndefined();
  });

  it('handles disc numbers with /total format', () => {
    const tracks: RawTrackTags[] = [
      {
        title: 'Track One',
        artist: 'Artist A',
        album: 'Album Title',
        tracknumber: '1',
        discnumber: '1/2',
        musicbrainz_recordingid: 'rec-1',
      },
      {
        title: 'Track Two',
        artist: 'Artist A',
        album: 'Album Title',
        tracknumber: '1',
        discnumber: '2/2',
        musicbrainz_recordingid: 'rec-2',
      },
    ];

    const flags = lintAlbum(tracks);
    const flag = flags.find((f) => f.rule === 'discNumberGaps');
    expect(flag).toBeUndefined();
  });

  it('handles array values (multi-value fields)', () => {
    const tracks: RawTrackTags[] = [
      {
        title: ['Track One'],
        artist: ['Artist A'],
        album: ['Album Title'],
        tracknumber: ['1'],
        musicbrainz_recordingid: ['rec-1'],
      },
    ];

    const flags = lintAlbum(tracks);
    expect(flags).toEqual([]);
  });
});
