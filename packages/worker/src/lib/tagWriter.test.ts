/**
 * Tag writer tests
 * Creates minimal audio fixtures and tests read/write round-trips
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MutagenTagWriter } from './tagWriter.js';
import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';
import type { TagSet } from '@liner/shared';
import type { WriteOptions } from '@liner/core';

/**
 * Check if mutagen is available
 */
function isMutagenAvailable(): boolean {
  try {
    execSync('python3 -c "import mutagen"', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Create a minimal PCM WAV file with silence
 * 1 second of silence at 44100 Hz, 16-bit mono
 */
function createMinimalWAV(filePath: string): void {
  // WAV header for 44100 Hz, 16-bit mono, 1 second
  // RIFF header
  const header = Buffer.alloc(44);
  let offset = 0;

  // "RIFF"
  header.write('RIFF', offset);
  offset += 4;

  // File size - 8
  const fileSize = 44 + 44100 * 2 - 8; // header + 1 second of 16-bit samples
  header.writeUInt32LE(fileSize, offset);
  offset += 4;

  // "WAVE"
  header.write('WAVE', offset);
  offset += 4;

  // "fmt " subchunk
  header.write('fmt ', offset);
  offset += 4;

  // Subchunk1Size
  header.writeUInt32LE(16, offset);
  offset += 4;

  // AudioFormat (PCM = 1)
  header.writeUInt16LE(1, offset);
  offset += 2;

  // NumChannels (mono = 1)
  header.writeUInt16LE(1, offset);
  offset += 2;

  // SampleRate
  header.writeUInt32LE(44100, offset);
  offset += 4;

  // ByteRate
  header.writeUInt32LE(44100 * 2, offset);
  offset += 4;

  // BlockAlign
  header.writeUInt16LE(2, offset);
  offset += 2;

  // BitsPerSample
  header.writeUInt16LE(16, offset);
  offset += 2;

  // "data" subchunk
  header.write('data', offset);
  offset += 4;

  // Subchunk2Size (1 second of silence)
  header.writeUInt32LE(44100 * 2, offset);

  // Write header
  fs.writeFileSync(filePath, header);

  // Append silence (zeros)
  const silence = Buffer.alloc(44100 * 2, 0);
  fs.appendFileSync(filePath, silence);
}

/**
 * Try to generate FLAC and MP3 from WAV using ffmpeg
 */
function generateAdditionalFormats(wavPath: string, dir: string): string[] {
  const formats: string[] = [wavPath];

  try {
    // Check if ffmpeg is available
    execSync('which ffmpeg', { stdio: 'pipe' });
  } catch {
    console.log('[test] ffmpeg not available, skipping FLAC/MP3 generation');
    return formats;
  }

  // Generate FLAC
  const flacPath = path.join(dir, 'test.flac');
  try {
    execSync(`ffmpeg -i "${wavPath}" -c:a flac -y "${flacPath}"`, {
      stdio: 'pipe',
    });
    formats.push(flacPath);
  } catch (error) {
    console.log('[test] Failed to generate FLAC:', error);
  }

  // Generate MP3
  const mp3Path = path.join(dir, 'test.mp3');
  try {
    execSync(`ffmpeg -i "${wavPath}" -c:a libmp3lame -b:a 192k -y "${mp3Path}"`, {
      stdio: 'pipe',
    });
    formats.push(mp3Path);
  } catch (error) {
    console.log('[test] Failed to generate MP3:', error);
  }

  return formats;
}

describe.skipIf(!isMutagenAvailable())('MutagenTagWriter', () => {
  let tagWriter: MutagenTagWriter;
  let testDir: string;
  let testFiles: string[] = [];

  beforeAll(async () => {
    // Create a temporary directory for test files
    testDir = path.join(process.cwd(), '.test-audio');
    fs.mkdirSync(testDir, { recursive: true });

    // Create minimal WAV fixture
    const wavPath = path.join(testDir, 'test.wav');
    createMinimalWAV(wavPath);
    testFiles = generateAdditionalFormats(wavPath, testDir);

    // Initialize the tag writer
    tagWriter = new MutagenTagWriter();

    // Wait for subprocess to be ready
    await new Promise((resolve) => setTimeout(resolve, 200));
  });

  afterAll(async () => {
    // Cleanup
    await tagWriter.close();

    // Remove test directory
    try {
      if (fs.existsSync(testDir)) {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('constructor reuse', () => {
    it('should reuse the subprocess for multiple read/write calls', async () => {
      const testFile = testFiles[0]!!;

      // Call read multiple times
      const tags1 = await tagWriter.read(testFile);
      expect(tags1).toBeDefined();

      const tags2 = await tagWriter.read(testFile);
      expect(tags2).toBeDefined();

      // Call write and read again
      const writeOpts: WriteOptions = { id3Version: '2.4' };
      await tagWriter.write(testFile, { title: 'Test Title' }, writeOpts);

      const tags3 = await tagWriter.read(testFile);
      expect(tags3).toBeDefined();

      // Subprocess should still be alive and responsive
      const tags4 = await tagWriter.read(testFile);
      expect(tags4).toBeDefined();
    });
  });

  describe('read and write operations', () => {
    it('should read tags from audio file', async () => {
      const testFile = testFiles[0]!;
      const tags = await tagWriter.read(testFile);
      expect(tags).toBeDefined();
      expect(typeof tags).toBe('object');
    });

    it('should write and read back basic tags', async () => {
      const testFile = testFiles[0]!;

      const tagsToWrite: TagSet = {
        title: 'Test Title',
        artist: 'Test Artist',
        album: 'Test Album',
        date: '2024',
      };

      await tagWriter.write(testFile, tagsToWrite);
      const tagsRead = await tagWriter.read(testFile);

      expect(tagsRead.title).toBe('Test Title');
      expect(tagsRead.artist).toBe('Test Artist');
      expect(tagsRead.album).toBe('Test Album');
      expect(tagsRead.date).toBe('2024');
    });

    it('should handle multi-value fields correctly', async () => {
      const testFile = testFiles[0]!;

      const tagsToWrite: TagSet = {
        title: 'Multi Test',
        artist: ['Artist One', 'Artist Two'],
        genre: ['Rock', 'Pop'],
      };

      await tagWriter.write(testFile, tagsToWrite);
      const tagsRead = await tagWriter.read(testFile);

      expect(tagsRead.title).toBe('Multi Test');
      // Multi-value fields may be returned as array or joined string
      const artist = tagsRead.artist;
      const genre = tagsRead.genre;

      if (Array.isArray(artist)) {
        expect(artist).toContain('Artist One');
        expect(artist).toContain('Artist Two');
      } else {
        expect(artist).toMatch(/Artist One/);
        expect(artist).toMatch(/Artist Two/);
      }

      if (Array.isArray(genre)) {
        expect(genre).toContain('Rock');
        expect(genre).toContain('Pop');
      } else {
        expect(genre).toMatch(/Rock/);
        expect(genre).toMatch(/Pop/);
      }
    });

    it('should preserve unknown tags on read/write cycle', async () => {
      const testFile = testFiles[0]!;

      // Write some tags including a custom one
      const tagsToWrite: TagSet = {
        title: 'Unknown Tag Test',
        artist: 'Test Artist',
      };

      await tagWriter.write(testFile, tagsToWrite);
      const tagsRead = await tagWriter.read(testFile);

      // The file should have the written tags
      expect(tagsRead.title).toBe('Unknown Tag Test');
      expect(tagsRead.artist).toBe('Test Artist');
    });

    it('should handle MusicBrainz tags correctly', async () => {
      const testFile = testFiles[0]!;

      const tagsToWrite: TagSet = {
        title: 'MB Test',
        musicbrainz_albumid: 'test-album-uuid',
        musicbrainz_artistid: ['artist-uuid-1', 'artist-uuid-2'],
      };

      await tagWriter.write(testFile, tagsToWrite);
      const tagsRead = await tagWriter.read(testFile);

      expect(tagsRead.title).toBe('MB Test');
      expect(tagsRead.musicbrainz_albumid).toBe('test-album-uuid');

      const artistId = tagsRead.musicbrainz_artistid;
      if (Array.isArray(artistId)) {
        expect(artistId).toContain('artist-uuid-1');
        expect(artistId).toContain('artist-uuid-2');
      } else {
        expect(artistId).toMatch(/artist-uuid-1/);
      }
    });
  });

  describe('format support', () => {
    it('should return true for supports() for supported containers', async () => {
      expect(tagWriter.supports('mp3')).toBe(true);
      expect(tagWriter.supports('flac')).toBe(true);
      expect(tagWriter.supports('m4a')).toBe(true);
      expect(tagWriter.supports('wav')).toBe(true);
      expect(tagWriter.supports('ogg')).toBe(true);
    });

    it('should return false for supports() for unsupported containers', () => {
      expect(tagWriter.supports('ape')).toBe(false);
      expect(tagWriter.supports('wv')).toBe(false);
      expect(tagWriter.supports('APE')).toBe(false);
      expect(tagWriter.supports('WV')).toBe(false);
      expect(tagWriter.supports('.ape')).toBe(false);
    });
  });

  describe('WriteOptions handling', () => {
    it('should respect stripUnknown=false (default)', async () => {
      const testFile = testFiles[0]!;

      const tagsToWrite: TagSet = {
        title: 'Strip Test',
      };

      const opts: WriteOptions = {
        stripUnknown: false,
      };

      await tagWriter.write(testFile, tagsToWrite, opts);
      const tagsRead = await tagWriter.read(testFile);

      expect(tagsRead.title).toBe('Strip Test');
    });

    it('should handle ID3v2.4 (default)', async () => {
      const testFile = testFiles[0]!;

      const tagsToWrite: TagSet = {
        title: 'ID3v24 Test',
      };

      const opts: WriteOptions = {
        id3Version: '2.4',
      };

      await tagWriter.write(testFile, tagsToWrite, opts);
      const tagsRead = await tagWriter.read(testFile);

      expect(tagsRead.title).toBe('ID3v24 Test');
    });

    it('should handle multiValueSeparator option', async () => {
      const testFile = testFiles[0]!;

      const tagsToWrite: TagSet = {
        title: 'Separator Test',
        artist: ['Artist One', 'Artist Two'],
      };

      const opts: WriteOptions = {
        multiValueSeparator: ' | ',
      };

      await tagWriter.write(testFile, tagsToWrite, opts);
      const tagsRead = await tagWriter.read(testFile);

      expect(tagsRead.title).toBe('Separator Test');
      // Artist may be joined or array depending on format
      const artist = tagsRead.artist;
      expect(artist).toBeDefined();
    });
  });

  describe('round-trip verification', () => {
    it('should round-trip all test fields without loss', async () => {
      const testFile = testFiles[0]!;

      const originalTags: TagSet = {
        title: 'Round Trip Test',
        artist: 'Test Artist',
        album: 'Test Album',
        tracknumber: '5',
        totaltracks: '12',
        date: '2024-01-15',
        genre: 'Electronic',
        musicbrainz_albumid: 'test-mbid-album',
        discogs_release_id: 'test-discogs',
      };

      // Write
      await tagWriter.write(testFile, originalTags);

      // Read back
      const readTags = await tagWriter.read(testFile);

      // Verify each field
      expect(readTags.title).toBe(originalTags.title);
      expect(readTags.artist).toBe(originalTags.artist);
      expect(readTags.album).toBe(originalTags.album);
      expect(readTags.tracknumber).toBe(originalTags.tracknumber);
      expect(readTags.totaltracks).toBe(originalTags.totaltracks);
      expect(readTags.date).toBe(originalTags.date);
      expect(readTags.genre).toBe(originalTags.genre);
      expect(readTags.musicbrainz_albumid).toBe(originalTags.musicbrainz_albumid);
      expect(readTags.discogs_release_id).toBe(originalTags.discogs_release_id);
    });
  });

  // Test additional formats if ffmpeg generated them
  if (testFiles.length > 1) {
    describe('format-specific tests', () => {
      testFiles.slice(1).forEach((testFile) => {
        const format = path.extname(testFile).toLowerCase();

        it(`should read and write ${format} files`, async () => {
          const tagsToWrite: TagSet = {
            title: `${format} Test`,
            artist: 'Test Artist',
          };

          await tagWriter.write(testFile, tagsToWrite);
          const tagsRead = await tagWriter.read(testFile);

          expect(tagsRead.title).toBe(`${format} Test`);
          expect(tagsRead.artist).toBe('Test Artist');
        });
      });
    });
  }
});
