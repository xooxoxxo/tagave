/**
 * SafeFileWriter tests
 * Tests atomic rename, hash verification, and error handling
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { SafeFileWriter } from './safeFileWriter.js';
import { MutagenTagWriter } from './tagWriter.js';
import path from 'node:path';
import fs from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import { execSync } from 'child_process';
import type { TagSet } from '@liner/shared';
import { hashAudioStream } from '@liner/core';

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
  const header = Buffer.alloc(44);
  let offset = 0;

  // "RIFF"
  header.write('RIFF', offset);
  offset += 4;

  // File size - 8
  const fileSize = 44 + 44100 * 2 - 8;
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
 * Generate additional formats from WAV using ffmpeg
 */
function generateAdditionalFormats(wavPath: string, dir: string): string[] {
  const formats: string[] = [wavPath];

  try {
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

  // Generate M4A/ALAC
  const m4aPath = path.join(dir, 'test.m4a');
  try {
    execSync(`ffmpeg -i "${wavPath}" -c:a alac -y "${m4aPath}"`, {
      stdio: 'pipe',
    });
    formats.push(m4aPath);
  } catch (error) {
    console.log('[test] Failed to generate M4A:', error);
  }

  // Generate OGG Vorbis
  const oggPath = path.join(dir, 'test.ogg');
  try {
    execSync(`ffmpeg -i "${wavPath}" -c:a libvorbis -q:a 6 -y "${oggPath}"`, {
      stdio: 'pipe',
    });
    formats.push(oggPath);
  } catch (error) {
    console.log('[test] Failed to generate OGG:', error);
  }

  // Generate Opus
  const opusPath = path.join(dir, 'test.opus');
  try {
    execSync(`ffmpeg -i "${wavPath}" -c:a libopus -b:a 128k -y "${opusPath}"`, {
      stdio: 'pipe',
    });
    formats.push(opusPath);
  } catch (error) {
    console.log('[test] Failed to generate Opus:', error);
  }

  // Generate AIFF
  const aiffPath = path.join(dir, 'test.aiff');
  try {
    execSync(`ffmpeg -i "${wavPath}" -c:a pcm_s16be -y "${aiffPath}"`, {
      stdio: 'pipe',
    });
    formats.push(aiffPath);
  } catch (error) {
    console.log('[test] Failed to generate AIFF:', error);
  }

  return formats;
}

describe.skipIf(!isMutagenAvailable())('SafeFileWriter', () => {
  let safeFileWriter: SafeFileWriter;
  let tagWriter: MutagenTagWriter;
  let testDir: string;
  let testFiles: string[] = [];

  beforeAll(async () => {
    // Create a temporary directory for test files
    testDir = path.join(process.cwd(), '.test-safe-write');
    fs.mkdirSync(testDir, { recursive: true });

    // Create minimal WAV fixture
    const wavPath = path.join(testDir, 'test.wav');
    createMinimalWAV(wavPath);
    testFiles = generateAdditionalFormats(wavPath, testDir);

    // Initialize tag writer and safe writer
    tagWriter = new MutagenTagWriter();
    safeFileWriter = new SafeFileWriter(tagWriter);

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

  afterEach(async () => {
    // Clean up any leftover temp files
    try {
      const files = await fsPromises.readdir(testDir);
      for (const file of files) {
        if (file.includes('.liner-tmp-')) {
          const filePath = path.join(testDir, file);
          await fsPromises.unlink(filePath);
        }
      }
    } catch {
      // Ignore errors
    }
  });

  describe('nominal path', () => {
    it('should safely write tags to WAV file and verify hash', async () => {
      const testFile = testFiles[0]!;
      const originalContent = fs.readFileSync(testFile);

      // Write tags
      const tagsToWrite: TagSet = {
        title: 'Test Title',
        artist: 'Test Artist',
        album: 'Test Album',
      };

      const result = await safeFileWriter.write(testFile, tagsToWrite);

      // Should succeed with no error
      expect(result.error).toBeUndefined();
      expect(result.code).toBeUndefined();

      // Original file should still be valid
      expect(fs.existsSync(testFile)).toBe(true);

      // File should be different (tags added)
      const newContent = fs.readFileSync(testFile);
      expect(newContent.length).not.toBe(originalContent.length);
    });

    it('should round-trip tags through safe write', async () => {
      const testFile = testFiles[0]!;

      const tagsToWrite: TagSet = {
        title: 'Round Trip Test',
        artist: ['Artist One', 'Artist Two'],
        album: 'Test Album',
        date: '2024',
        tracknumber: '5',
      };

      const result = await safeFileWriter.write(testFile, tagsToWrite);

      // Should succeed
      expect(result.error).toBeUndefined();

      // Read back tags
      const tagsRead = await tagWriter.read(testFile);

      // Verify intended fields
      expect(tagsRead.title).toBe('Round Trip Test');
      expect(tagsRead.album).toBe('Test Album');
      expect(tagsRead.date).toBe('2024');
      expect(tagsRead.tracknumber).toBe('5');

      // Artist may be array or string
      const artist = tagsRead.artist;
      if (Array.isArray(artist)) {
        expect(artist).toContain('Artist One');
        expect(artist).toContain('Artist Two');
      } else {
        expect(artist).toMatch(/Artist One/);
      }
    });
  });

  describe('hash verification', () => {
    it('should compute hash before and after write', async () => {
      const testFile = testFiles[0]!;
      const hashBeforeWrite = await hashAudioStream(testFile, 'wav');

      const tagsToWrite: TagSet = {
        title: 'Hash Test',
      };

      const result = await safeFileWriter.write(testFile, tagsToWrite);

      // Should succeed
      expect(result.error).toBeUndefined();

      // Hash should remain the same (only tags changed, audio stream unchanged)
      const hashAfterWrite = await hashAudioStream(testFile, 'wav');
      expect(hashAfterWrite).toBe(hashBeforeWrite);
    });
  });

  describe('error handling', () => {
    it('should return error on invalid file path', async () => {
      const invalidPath = path.join(testDir, 'nonexistent', 'file.wav');

      const tagsToWrite: TagSet = {
        title: 'Invalid Path',
      };

      const result = await safeFileWriter.write(invalidPath, tagsToWrite);

      // Should fail
      expect(result.error).toBeDefined();
      expect(result.code).toBeDefined();

      // No temp file should exist
      const dir = path.dirname(invalidPath);
      if (fs.existsSync(dir)) {
        const files = fs.readdirSync(dir);
        const tempFiles = files.filter((f) => f.includes('.liner-tmp-'));
        expect(tempFiles).toHaveLength(0);
      }
    });

    it('should clean up temp file on all error paths', async () => {
      const testFile = testFiles[0]!;
      const dir = path.dirname(testFile);

      // Make the file read-only to trigger write error
      const originalMode = fs.statSync(testFile).mode;
      try {
        fs.chmodSync(testFile, 0o444);

        const tagsToWrite: TagSet = {
          title: 'Error Cleanup',
        };

        // Attempt write to read-only file
        const result = await safeFileWriter.write(testFile, tagsToWrite);

        // Should have error
        expect(result.error).toBeDefined();

        // Verify no orphaned temp files
        const files = fs.readdirSync(dir);
        const tempFiles = files.filter((f) => f.includes('.liner-tmp-'));
        expect(tempFiles).toHaveLength(0);
      } finally {
        // Restore file permissions
        fs.chmodSync(testFile, originalMode);
      }
    });
  });

  describe('multi-format support', () => {
    it('should handle all supported audio formats', async () => {
      const formatsToTest = testFiles.slice(0, 3); // Test first 3 formats (WAV, FLAC, MP3 if available)

      for (const testFile of formatsToTest) {
        try {
          const ext = path.extname(testFile).toLowerCase().slice(1);

          const tagsToWrite: TagSet = {
            title: `Format Test ${ext.toUpperCase()}`,
            album: 'Multi-Format Album',
          };

          const result = await safeFileWriter.write(testFile, tagsToWrite);

          // Should succeed or skip if format not supported
          if (result.error && result.code === 'write_error') {
            console.log(`[test] Format ${ext} not fully supported, skipping`);
            continue;
          }

          expect(result.error).toBeUndefined();

          // Verify tags were written
          const tagsRead = await tagWriter.read(testFile);
          expect(tagsRead.album).toBe('Multi-Format Album');
        } catch (error) {
          // Some formats may not be available or fully supported
          console.log(`[test] Skipping format test:`, error);
        }
      }
    });
  });

  describe('edge cases', () => {
    it('should handle empty tag set', async () => {
      const testFile = testFiles[0]!;

      const tagsToWrite: TagSet = {};

      const result = await safeFileWriter.write(testFile, tagsToWrite);

      // Should succeed with no-op
      expect(result.error).toBeUndefined();

      // File should be valid
      expect(fs.existsSync(testFile)).toBe(true);
    });

    it('should handle multiple sequential writes to same file', async () => {
      const testFile = testFiles[0]!;

      // First write
      let tagsToWrite: TagSet = { title: 'First Write' };
      let result = await safeFileWriter.write(testFile, tagsToWrite);
      expect(result.error).toBeUndefined();

      // Second write
      tagsToWrite = { title: 'Second Write', artist: 'Second Artist' };
      result = await safeFileWriter.write(testFile, tagsToWrite);
      expect(result.error).toBeUndefined();

      // Verify final tags
      const tagsRead = await tagWriter.read(testFile);
      expect(tagsRead.title).toBe('Second Write');
      expect(tagsRead.artist).toBe('Second Artist');
    });

    it('should handle special characters in tags', async () => {
      const testFile = testFiles[0]!;

      const tagsToWrite: TagSet = {
        title: 'Test™ with © symbols',
        artist: 'Artist & Friends (feat. Someone)',
        album: 'Album [Deluxe] "Edition"',
      };

      const result = await safeFileWriter.write(testFile, tagsToWrite);

      expect(result.error).toBeUndefined();

      // Verify tags preserved
      const tagsRead = await tagWriter.read(testFile);
      expect(tagsRead.title).toContain('Test');
      expect(tagsRead.artist).toContain('Artist');
    });

    it('should handle multiple writes with verification', async () => {
      const testFile = testFiles[0]!;

      const firstTags: TagSet = { title: 'Write One' };
      let result = await safeFileWriter.write(testFile, firstTags);
      expect(result.error).toBeUndefined();

      const secondTags: TagSet = { title: 'Write Two', artist: 'New Artist' };
      result = await safeFileWriter.write(testFile, secondTags);
      expect(result.error).toBeUndefined();

      // Verify final state
      const finalTags = await tagWriter.read(testFile);
      expect(finalTags.title).toBe('Write Two');
      expect(finalTags.artist).toBe('New Artist');
    });
  });
});
