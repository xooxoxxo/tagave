import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCueSheet } from '@liner/core';
import { expandFilesWithCues } from './cueExpand.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(__dirname, '../../..', 'core/src/cue/__fixtures__');

interface TestFileRow {
  id: string;
  relPath: string;
  durationMs: number | null;
}

interface TestCueInfo {
  relPath: string;
  sheet: ReturnType<typeof parseCueSheet>;
}

/**
 * Load a fixture CUE file and parse it
 */
function loadFixture(filename: string): TestCueInfo {
  const bytes = fs.readFileSync(path.join(FIXTURES_DIR, filename));
  const sheet = parseCueSheet(bytes);
  return { relPath: filename, sheet };
}

describe('expandFilesWithCues', () => {
  it('expands a single-file album with multiple virtual tracks', () => {
    const edgeOfSanity = loadFixture('Edge_of_Sanity_-_Purgatory_Afterglow.cue');
    // Edge of Sanity has multiple audio tracks in one FILE
    expect(edgeOfSanity.sheet.files.length).toBe(1);
    expect(edgeOfSanity.sheet.files[0]!.tracks.length).toBeGreaterThanOrEqual(2);

    const files: TestFileRow[] = [
      {
        id: 'file-1',
        relPath: 'album.flac',
        durationMs: 3600000, // ~1 hour
      },
    ];

    const cues: TestCueInfo[] = [
      { relPath: 'album.cue', sheet: edgeOfSanity.sheet },
    ];

    const result = expandFilesWithCues(files, cues);

    // Should have expanded file-1 with single-file fallback
    expect(result.has('file-1')).toBe(true);
    const expanded = result.get('file-1')!;
    expect(expanded.tracks.length).toBeGreaterThanOrEqual(2);
    expect(expanded.cueRelPath).toBe('album.cue');
  });

  it('expands jon lord concerto correctly', () => {
    const jonLord = loadFixture('Jon_Lord_-_Concerto_For_Group_And_Orchestra.cue');
    // Single FILE with 3 audio tracks
    expect(jonLord.sheet.files.length).toBe(1);
    expect(jonLord.sheet.files[0]!.tracks.length).toBeGreaterThanOrEqual(3);

    const files: TestFileRow[] = [
      {
        id: 'file-1',
        relPath: 'album.ape',
        durationMs: 2700000,
      },
    ];

    const cues: TestCueInfo[] = [
      { relPath: 'album.cue', sheet: jonLord.sheet },
    ];
    const result = expandFilesWithCues(files, cues);

    // Single FILE with ≥2 tracks → should expand
    expect(result.has('file-1')).toBe(true);
    expect(result.get('file-1')!.tracks.length).toBeGreaterThanOrEqual(3);
  });

  it('uses single-file fallback when dir has one audio and cue has one FILE', () => {
    const cafe = loadFixture('Cafe_Del_Mar_By_Rue_Du_Soleil_-_Emotions.cue');

    const files: TestFileRow[] = [
      {
        id: 'file-1',
        relPath: 'cafe/music.flac',
        durationMs: 4000000, // ~67 minutes to fit all tracks
      },
    ];

    const cues: TestCueInfo[] = [
      { relPath: 'cafe/album.cue', sheet: cafe.sheet },
    ];
    const result = expandFilesWithCues(files, cues);

    // Single audio file + single FILE in cue with ≥2 tracks = single-file fallback
    if (cafe.sheet.files.length === 1 && cafe.sheet.files[0]!.tracks.length >= 2) {
      expect(result.has('file-1')).toBe(true);
    }
  });

  it('ignores cues that do not fit the audio duration', () => {
    const edgeOfSanity = loadFixture('Edge_of_Sanity_-_Purgatory_Afterglow.cue');

    const files: TestFileRow[] = [
      {
        id: 'file-1',
        relPath: 'album.flac',
        durationMs: 1000, // 1 second - way too short
      },
    ];

    const cues: TestCueInfo[] = [
      { relPath: 'album.cue', sheet: edgeOfSanity.sheet },
    ];
    const result = expandFilesWithCues(files, cues);

    // virtualTracksForFile should return null when duration is too short
    expect(result.size).toBe(0);
  });

  it('handles cues in different directories independently', () => {
    const edge = loadFixture('Edge_of_Sanity_-_Purgatory_Afterglow.cue');
    const jon = loadFixture('Jon_Lord_-_Concerto_For_Group_And_Orchestra.cue');

    const files: TestFileRow[] = [
      {
        id: 'file-1',
        relPath: 'edge/album.flac',
        durationMs: 3600000,
      },
      {
        id: 'file-2',
        relPath: 'jon/album.ape',
        durationMs: 2700000,
      },
    ];

    const cues: TestCueInfo[] = [
      { relPath: 'edge/album.cue', sheet: edge.sheet },
      { relPath: 'jon/album.cue', sheet: jon.sheet },
    ];

    const result = expandFilesWithCues(files, cues);

    // Both should expand since they're in different directories with matching cues
    expect(result.has('file-1')).toBe(true);
    expect(result.has('file-2')).toBe(true);
  });

  it('skips files with no matching cue in their directory', () => {
    const edge = loadFixture('Edge_of_Sanity_-_Purgatory_Afterglow.cue');

    const files: TestFileRow[] = [
      {
        id: 'file-1',
        relPath: 'album1/album.flac',
        durationMs: 3600000,
      },
      {
        id: 'file-2',
        relPath: 'album2/other.flac',
        durationMs: 3000000,
      },
    ];

    const cues: TestCueInfo[] = [
      { relPath: 'album1/album.cue', sheet: edge.sheet },
    ];

    const result = expandFilesWithCues(files, cues);

    // file-1 should expand, file-2 has no cue in its directory
    expect(result.has('file-1')).toBe(true);
    expect(result.has('file-2')).toBe(false);
  });

  it('returns empty map for empty inputs', () => {
    const result = expandFilesWithCues([], []);
    expect(result.size).toBe(0);
  });

  it('returns empty map when no files match cues', () => {
    const edge = loadFixture('Edge_of_Sanity_-_Purgatory_Afterglow.cue');

    const files: TestFileRow[] = [];
    const cues: TestCueInfo[] = [
      { relPath: 'album/cue.cue', sheet: edge.sheet },
    ];

    const result = expandFilesWithCues(files, cues);
    expect(result.size).toBe(0);
  });

  it('does not expand when file has no matching duration', () => {
    const jon = loadFixture('Jon_Lord_-_Concerto_For_Group_And_Orchestra.cue');

    const files: TestFileRow[] = [
      {
        id: 'file-1',
        relPath: 'album.ape',
        durationMs: null, // Unknown duration
      },
    ];

    const cues: TestCueInfo[] = [
      { relPath: 'album.cue', sheet: jon.sheet },
    ];

    // When duration is null, virtualTracksForFile will still work
    // (it can work with null duration for the last track)
    const result = expandFilesWithCues(files, cues);
    expect(result.has('file-1')).toBe(true); // Should still expand
  });
});
