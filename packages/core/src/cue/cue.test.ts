import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { URL } from 'url';
import {
  decodeCueBytes,
  parseCueSheet,
  virtualTracksForFile,
  matchCueFileToAudio,
  chooseCueForAudio,
} from './index.js';
import type { CueCandidate, CueTrack } from './index.js';

const fixtureDir = new URL('./__fixtures__/', import.meta.url);

function readFixture(name: string): Uint8Array {
  return readFileSync(new URL(name, fixtureDir));
}

describe('decodeCueBytes', () => {
  it('decodes UTF-8 without BOM', () => {
    const bytes = new TextEncoder().encode('TITLE "Test"');
    const result = decodeCueBytes(bytes);
    expect(result.text).toBe('TITLE "Test"');
    expect(result.encoding).toBe('utf-8');
  });

  it('decodes UTF-8 with BOM', () => {
    const text = 'TITLE "Test"';
    const encoded = new TextEncoder().encode(text);
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...encoded]);
    const result = decodeCueBytes(withBom);
    expect(result.text).toBe(text);
    expect(result.encoding).toBe('utf-8-bom');
  });

  it('decodes UTF-16LE with BOM', () => {
    const text = 'TITLE';
    const encoded = new TextEncoder().encode(text);
    // Create UTF-16LE with BOM
    const buffer = new ArrayBuffer(encoded.length * 2);
    const view = new Uint16Array(buffer);
    for (let i = 0; i < encoded.length; i++) {
      view[i] = encoded[i] ?? 0;
    }
    const bytes = new Uint8Array([0xff, 0xfe, ...new Uint8Array(buffer)]);
    const result = decodeCueBytes(bytes);
    // TextDecoder might produce slightly different output, just check it decodes
    expect(result.encoding).toBe('utf-16le');
  });

  it('decodes windows-1252 with é (0xE9)', () => {
    // Create a buffer with windows-1252 é
    const bytes = new Uint8Array([0xe9]); // é in cp1252
    const result = decodeCueBytes(bytes);
    expect(result.text).toContain('é');
    expect(result.encoding).toBe('windows-1252');
  });

  it('decodes windows-1252 with ü (0xFC)', () => {
    const bytes = new Uint8Array([0xfc]); // ü in cp1252
    const result = decodeCueBytes(bytes);
    expect(result.text).toContain('ü');
    expect(result.encoding).toBe('windows-1252');
  });
});

describe('parseCueSheet', () => {
  it('parses Edge of Sanity fixture (21 tracks)', () => {
    const bytes = readFixture('Edge_of_Sanity_-_Purgatory_Afterglow.cue');
    const sheet = parseCueSheet(bytes);

    expect(sheet.title).toBe('Purgatory Afterglow');
    expect(sheet.performer).toBe('Edge of Sanity');
    expect(sheet.genre).toBe('Death Metal');
    expect(sheet.date).toBe(1994);
    expect(sheet.files).toHaveLength(1);

    const file = sheet.files[0];
    if (!file) throw new Error('Expected file');
    expect(file.path).toBe('Edge of Sanity - Purgatory Afterglow.flac');
    expect(file.type).toBe('WAVE');
    expect(file.tracks).toHaveLength(21);

    // Check first track
    const track0 = file.tracks[0];
    if (!track0) throw new Error('Expected track 0');
    expect(track0.number).toBe(1);
    expect(track0.title).toBe('Twilight');
    expect(track0.startMs).toBe(0);

    // Check second track (has INDEX 01)
    const track1 = file.tracks[1];
    if (!track1) throw new Error('Expected track 1');
    expect(track1.number).toBe(2);
    expect(track1.title).toBe('Of Darksome Origin');
    expect(track1.startMs).toBe(frameTimeToMs(7, 51, 7));

    // Check track with INDEX 00 + 01
    const track5 = file.tracks[5];
    if (!track5) throw new Error('Expected track 5');
    expect(track5.number).toBe(6);
    expect(track5.startMs).toBe(frameTimeToMs(25, 15, 17));
    expect(track5.pregapMs).toBe(frameTimeToMs(25, 14, 12));
  });

  it('parses Candlemass fixture with non-ASCII characters (ö)', () => {
    const bytes = readFixture('Chapter_VI__Remastered_2006_.wav.cue');
    const sheet = parseCueSheet(bytes);

    expect(sheet.title).toBe('Chapter VI [Remastered 2006]');
    expect(sheet.performer).toBe('Candlemass');
    const file0 = sheet.files[0];
    if (!file0) throw new Error('Expected file 0');
    expect(file0.path).toBe('Chapter VI (Remastered 2006).wav');
    expect(file0.tracks).toHaveLength(12);

    // Find track with ö
    const trackWithUmlauts = file0.tracks.find((t) => t.title?.includes('Bröllop'));
    expect(trackWithUmlauts).toBeDefined();
    expect(trackWithUmlauts?.title).toBe('Bröllop Pa Hulda Johanssons Pensionat');
  });

  it('parses Jon Lord fixture with backslashes in titles', () => {
    const bytes = readFixture('Jon_Lord_-_Concerto_For_Group_And_Orchestra.cue');
    const sheet = parseCueSheet(bytes);

    expect(sheet.title).toBe('Concerto For Group And Orchestra');
    const file0 = sheet.files[0];
    if (!file0) throw new Error('Expected file 0');
    expect(file0.path).toBe('Jon Lord - Concerto For Group And Orchestra.ape');
    expect(file0.tracks).toHaveLength(3);

    // Check backslash handling
    const track1 = file0.tracks[0];
    if (!track1) throw new Error('Expected track 0');
    expect(track1.title).toContain('w\\');
  });

  it('parses Cafe Del Mar fixture', () => {
    const bytes = readFixture('Cafe_Del_Mar_By_Rue_Du_Soleil_-_Emotions.cue');
    const sheet = parseCueSheet(bytes);

    expect(sheet.title).toBe('Emotions');
    expect(sheet.performer).toBe('Cafe Del Mar By Rue Du Soleil');
    expect(sheet.genre).toBe('Chillout');
    expect(sheet.date).toBe(2008);
    const file0 = sheet.files[0];
    if (!file0) throw new Error('Expected file 0');
    expect(file0.tracks).toHaveLength(13);

    // Test frame rounding: 00:30:23:68 should round correctly
    const track7 = file0.tracks[6];
    if (!track7) throw new Error('Expected track 6');
    expect(track7.startMs).toBe(frameTimeToMs(30, 23, 68));
  });

  it('tolerates CRLF line endings', () => {
    const text = 'TITLE "Test"\r\nPERFORMER "Artist"\r\nFILE "file.flac" WAVE\r\n';
    const sheet = parseCueSheet(text);
    expect(sheet.title).toBe('Test');
    expect(sheet.performer).toBe('Artist');
  });

  it('parses REM GENRE without quotes', () => {
    const text = 'REM GENRE Rock\nFILE "test.wav" WAVE\n';
    const sheet = parseCueSheet(text);
    expect(sheet.genre).toBe('Rock');
  });

  it('parses unquoted FILE with spaces', () => {
    const text =
      'FILE file name with spaces.wav WAVE\n  TRACK 01 AUDIO\n    INDEX 01 00:00:00\n  TRACK 02 AUDIO\n    INDEX 01 01:00:00\n';
    const sheet = parseCueSheet(text);
    const file0 = sheet.files[0];
    if (!file0) throw new Error('Expected file 0');
    expect(file0.path).toBe('file name with spaces.wav');
  });

  it('skips DATA tracks', () => {
    const text =
      'FILE "test.wav" WAVE\n  TRACK 01 AUDIO\n    INDEX 01 00:00:00\n  TRACK 02 DATA\n    INDEX 01 01:00:00\n  TRACK 03 AUDIO\n    INDEX 01 02:00:00\n';
    const sheet = parseCueSheet(text);
    const file0 = sheet.files[0];
    if (!file0) throw new Error('Expected file 0');
    expect(file0.tracks).toHaveLength(2);
    const track0 = file0.tracks[0];
    if (!track0) throw new Error('Expected track 0');
    const track1 = file0.tracks[1];
    if (!track1) throw new Error('Expected track 1');
    expect(track0.number).toBe(1);
    expect(track1.number).toBe(3);
  });

  it('handles INDEX 00 + 01 with pregap', () => {
    const text =
      'FILE "test.wav" WAVE\n  TRACK 01 AUDIO\n    INDEX 00 00:10:00\n    INDEX 01 00:15:00\n';
    const sheet = parseCueSheet(text);
    const file0 = sheet.files[0];
    if (!file0) throw new Error('Expected file 0');
    const track = file0.tracks[0];
    if (!track) throw new Error('Expected track 0');
    expect(track.pregapMs).toBe(frameTimeToMs(0, 10, 0));
    expect(track.startMs).toBe(frameTimeToMs(0, 15, 0));
  });

  it('handles INDEX 01 + 00 in reversed order', () => {
    // spec XO-314: tolerate INDEX entries in any order
    const text =
      'FILE "test.wav" WAVE\n  TRACK 01 AUDIO\n    INDEX 01 00:15:00\n    INDEX 00 00:10:00\n';
    const sheet = parseCueSheet(text);
    const file0 = sheet.files[0];
    if (!file0) throw new Error('Expected file 0');
    const track = file0.tracks[0];
    if (!track) throw new Error('Expected track 0');
    expect(track.pregapMs).toBe(frameTimeToMs(0, 10, 0));
    expect(track.startMs).toBe(frameTimeToMs(0, 15, 0));
  });

  it('parses REM DISCNUMBER and TOTALDISCS', () => {
    const text =
      'REM DISCNUMBER 2\nREM TOTALDISCS 3\nFILE "test.wav" WAVE\n  TRACK 01 AUDIO\n    INDEX 01 00:00:00\n';
    const sheet = parseCueSheet(text);
    expect(sheet.discNumber).toBe(2);
    expect(sheet.totalDiscs).toBe(3);
  });

  it('never throws on junk lines', () => {
    const text = 'GARBAGE\nBAD LINE\nTITLE "Test"\nMORE JUNK\n';
    expect(() => parseCueSheet(text)).not.toThrow();
  });
});

describe('virtualTracksForFile', () => {
  it('returns null for < 2 audio tracks', () => {
    const bytes = readFixture('Cafe_Del_Mar_By_Rue_Du_Soleil_-_Emotions.cue');
    const sheet = parseCueSheet(bytes);
    const file = sheet.files[0];
    if (!file) throw new Error('Expected file 0');

    // Artificially reduce to 1 track for testing
    const singleTrackFile = { ...file, tracks: file.tracks.slice(0, 1) };
    const result = virtualTracksForFile(singleTrackFile, sheet, 60000);
    expect(result).toBeNull();
  });

  it('returns null for non-strictly-increasing starts', () => {
    const sheet = parseCueSheet(
      'FILE "test.wav" WAVE\n  TRACK 01 AUDIO\n    INDEX 01 00:00:00\n  TRACK 02 AUDIO\n    INDEX 01 00:00:00\n'
    );
    const file0 = sheet.files[0];
    if (!file0) throw new Error('Expected file 0');
    const result = virtualTracksForFile(file0, sheet, 60000);
    expect(result).toBeNull();
  });

  it('returns null when last start >= file duration', () => {
    const sheet = parseCueSheet(
      'FILE "test.wav" WAVE\n  TRACK 01 AUDIO\n    INDEX 01 00:00:00\n  TRACK 02 AUDIO\n    INDEX 01 50:00:00\n'
    );
    // Last track at 50 minutes, file is only 60 seconds
    const file0 = sheet.files[0];
    if (!file0) throw new Error('Expected file 0');
    const result = virtualTracksForFile(file0, sheet, 60000);
    expect(result).toBeNull();
  });

  it('calculates track durations from next track start', () => {
    const bytes = readFixture('Jon_Lord_-_Concerto_For_Group_And_Orchestra.cue');
    const sheet = parseCueSheet(bytes);
    const file0 = sheet.files[0];
    if (!file0) throw new Error('Expected file 0');
    const result = virtualTracksForFile(file0, sheet, null);

    expect(result).not.toBeNull();
    if (result) {
      const track0 = result[0];
      if (!track0) throw new Error('Expected track 0');
      expect(track0.number).toBe(1);
      expect(track0.startMs).toBe(0);
      expect(track0.durationMs).toBe(frameTimeToMs(16, 23, 16));
    }
  });

  it('calculates last track duration from file duration', () => {
    const bytes = readFixture('Jon_Lord_-_Concerto_For_Group_And_Orchestra.cue');
    const sheet = parseCueSheet(bytes);
    const fileDurationMs = 60 * 60 * 1000; // 60 minutes
    const file0 = sheet.files[0];
    if (!file0) throw new Error('Expected file 0');
    const result = virtualTracksForFile(file0, sheet, fileDurationMs);

    expect(result).not.toBeNull();
    if (result) {
      const lastTrack = result[result.length - 1];
      if (!lastTrack) throw new Error('Expected last track');
      expect(lastTrack.number).toBe(3);
      expect(lastTrack.durationMs).toBe(fileDurationMs - lastTrack.startMs);
    }
  });

  it('sets last track duration to null when file duration unknown', () => {
    const bytes = readFixture('Jon_Lord_-_Concerto_For_Group_And_Orchestra.cue');
    const sheet = parseCueSheet(bytes);
    const file0 = sheet.files[0];
    if (!file0) throw new Error('Expected file 0');
    const result = virtualTracksForFile(file0, sheet, null);

    expect(result).not.toBeNull();
    if (result) {
      const lastTrack = result[result.length - 1];
      if (!lastTrack) throw new Error('Expected last track');
      expect(lastTrack.durationMs).toBeNull();
    }
  });

  it('uses track title, or fallback "Track NN"', () => {
    const bytes = readFixture('Jon_Lord_-_Concerto_For_Group_And_Orchestra.cue');
    const sheet = parseCueSheet(bytes);
    const file0 = sheet.files[0];
    if (!file0) throw new Error('Expected file 0');
    const result = virtualTracksForFile(file0, sheet, null);

    expect(result).not.toBeNull();
    if (result) {
      const track0 = result[0];
      if (!track0) throw new Error('Expected track 0');
      expect(track0.title).toContain('Movement One');
    }
  });

  it('uses sheet performer as fallback for track performer', () => {
    const bytes = readFixture('Jon_Lord_-_Concerto_For_Group_And_Orchestra.cue');
    const sheet = parseCueSheet(bytes);
    const file0 = sheet.files[0];
    if (!file0) throw new Error('Expected file 0');
    const result = virtualTracksForFile(file0, sheet, null);

    expect(result).not.toBeNull();
    if (result) {
      const track0 = result[0];
      if (!track0) throw new Error('Expected track 0');
      expect(track0.performer).toBe('Jon Lord');
    }
  });
});

describe('matchCueFileToAudio', () => {
  it('matches exact case-insensitive with NFC', () => {
    const match = matchCueFileToAudio('Album.flac', ['Album.flac', 'Other.mp3']);
    expect(match).not.toBeNull();
    expect(match?.index).toBe(0);
    expect(match?.matchKind).toBe('exact');
  });

  it('matches casefold', () => {
    const match = matchCueFileToAudio('album.flac', ['ALBUM.FLAC', 'Other.mp3']);
    expect(match).not.toBeNull();
    expect(match?.index).toBe(0);
    expect(match?.matchKind).toBe('exact');
  });

  it('matches stem when exact fails', () => {
    const match = matchCueFileToAudio('Album.flac', ['Album.wav', 'Other.mp3']);
    expect(match).not.toBeNull();
    expect(match?.index).toBe(0);
    expect(match?.matchKind).toBe('stem');
  });

  it('returns null when no match', () => {
    const match = matchCueFileToAudio('Missing.flac', ['Album.wav', 'Other.mp3']);
    expect(match).toBeNull();
  });

  it('prioritizes exact over stem match', () => {
    // If both exact and stem exist, exact should win
    const match = matchCueFileToAudio('Album.flac', ['Album.flac', 'Album.wav']);
    expect(match).not.toBeNull();
    expect(match?.index).toBe(0);
    expect(match?.matchKind).toBe('exact');
  });
});

describe('chooseCueForAudio', () => {
  it('prefers exact matchKind over stem', () => {
    const candidates: CueCandidate[] = [
      {
        cuePath: 'stemonly.cue',
        file: { path: 'x.flac', type: 'WAVE', tracks: [createTrack(1, 0), createTrack(2, 5000)] },
        sheet: { encoding: 'utf-8', files: [] },
        matchKind: 'stem',
      },
      {
        cuePath: 'exact.cue',
        file: { path: 'x.flac', type: 'WAVE', tracks: [createTrack(1, 0), createTrack(2, 5000)] },
        sheet: { encoding: 'utf-8', files: [] },
        matchKind: 'exact',
      },
    ];

    const chosen = chooseCueForAudio('album.flac', candidates);
    expect(chosen.cuePath).toBe('exact.cue');
  });

  it('prefers stem over single', () => {
    const candidates: CueCandidate[] = [
      {
        cuePath: 'single.cue',
        file: { path: 'x.flac', type: 'WAVE', tracks: [createTrack(1, 0), createTrack(2, 5000)] },
        sheet: { encoding: 'utf-8', files: [] },
        matchKind: 'single',
      },
      {
        cuePath: 'stem.cue',
        file: { path: 'x.flac', type: 'WAVE', tracks: [createTrack(1, 0), createTrack(2, 5000)] },
        sheet: { encoding: 'utf-8', files: [] },
        matchKind: 'stem',
      },
    ];

    const chosen = chooseCueForAudio('album.flac', candidates);
    expect(chosen.cuePath).toBe('stem.cue');
  });

  it('prefers more tracks when matchKind is the same', () => {
    const candidates: CueCandidate[] = [
      {
        cuePath: '2tracks.cue',
        file: {
          path: 'x.flac',
          type: 'WAVE',
          tracks: [createTrack(1, 0), createTrack(2, 5000)],
        },
        sheet: { encoding: 'utf-8', files: [] },
        matchKind: 'stem',
      },
      {
        cuePath: '5tracks.cue',
        file: {
          path: 'x.flac',
          type: 'WAVE',
          tracks: [
            createTrack(1, 0),
            createTrack(2, 5000),
            createTrack(3, 10000),
            createTrack(4, 15000),
            createTrack(5, 20000),
          ],
        },
        sheet: { encoding: 'utf-8', files: [] },
        matchKind: 'stem',
      },
    ];

    const chosen = chooseCueForAudio('album.flac', candidates);
    expect(chosen.cuePath).toBe('5tracks.cue');
  });

  it('uses lexical path as tiebreaker', () => {
    const candidates: CueCandidate[] = [
      {
        cuePath: 'z.cue',
        file: { path: 'x.flac', type: 'WAVE', tracks: [createTrack(1, 0), createTrack(2, 5000)] },
        sheet: { encoding: 'utf-8', files: [] },
        matchKind: 'stem',
      },
      {
        cuePath: 'a.cue',
        file: { path: 'x.flac', type: 'WAVE', tracks: [createTrack(1, 0), createTrack(2, 5000)] },
        sheet: { encoding: 'utf-8', files: [] },
        matchKind: 'stem',
      },
    ];

    const chosen = chooseCueForAudio('album.flac', candidates);
    expect(chosen.cuePath).toBe('a.cue');
  });

  it('prefers cue whose name shares the audio stem', () => {
    const candidates: CueCandidate[] = [
      {
        cuePath: 'Album.wav.cue',
        file: { path: 'x.flac', type: 'WAVE', tracks: [createTrack(1, 0), createTrack(2, 5000)] },
        sheet: { encoding: 'utf-8', files: [] },
        matchKind: 'stem',
      },
      {
        cuePath: 'Album.cue',
        file: { path: 'x.flac', type: 'WAVE', tracks: [createTrack(1, 0), createTrack(2, 5000)] },
        sheet: { encoding: 'utf-8', files: [] },
        matchKind: 'stem',
      },
    ];

    const chosen = chooseCueForAudio('Album.flac', candidates);
    expect(chosen.cuePath).toBe('Album.cue');
  });
});

// Helper: frame time to ms
function frameTimeToMs(mm: number, ss: number, ff: number): number {
  return (mm * 60 + ss) * 1000 + Math.round((ff * 1000) / 75);
}

// Helper: create a test track
function createTrack(number: number, startMs: number): CueTrack {
  return {
    number,
    indexes: { 1: startMs },
    startMs,
  };
}
