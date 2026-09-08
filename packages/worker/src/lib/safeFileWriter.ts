/**
 * SafeFileWriter - Safe audio file tag writing with atomic rename and hash verification
 * Implements spec §12.6 TAG-4: temp copy → sidecar write → re-read → hash verify → atomic rename
 */

import { promises as fs, open as fsOpen, fsync, close } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseFile } from 'music-metadata';
import { statfs } from 'node:fs';
import type { TagSet } from '@liner/shared';
import { hashAudioStream } from '@liner/core';
import type { TagWriter, WriteOptions } from '@liner/core';

/**
 * Result from a write operation
 */
export interface WriteResult {
  error?: string;
  code?: string;
}

/**
 * SafeFileWriter ensures tag writes never corrupt audio files
 * Uses atomic rename and hash verification per spec §12.6 TAG-4
 */
export class SafeFileWriter {
  constructor(private tagWriter: TagWriter) {}

  /**
   * Safely write tags to an audio file.
   * Flow: hash before → temp copy → sidecar write → re-read → hash compare → rename → fsync
   * Returns {error, code} on any failure without touching original.
   *
   * @param filePath - Full path to the audio file
   * @param tagSet - Tags to write
   * @param opts - Write options (id3Version, separator, etc.)
   * @returns {error?, code?} - undefined on success, or error details on failure
   */
  async write(
    filePath: string,
    tagSet: TagSet,
    opts?: WriteOptions
  ): Promise<WriteResult> {
    const dir = path.dirname(filePath);
    const filename = path.basename(filePath);
    const tempFilename = `.liner-tmp-${randomUUID()}${path.extname(filename)}`;
    const tempFilePath = path.join(dir, tempFilename);

    try {
      // 0. Compute audio-stream hash of original file
      let hashBefore: string;
      try {
        const ext = path.extname(filePath).toLowerCase().slice(1);
        hashBefore = await hashAudioStream(filePath, ext);
      } catch (hashError) {
        const message = hashError instanceof Error ? hashError.message : String(hashError);
        return { error: `hash_before_failed: ${message}`, code: 'hash_error' };
      }

      // 1. Free-space precheck
      const spaceCheck = await this.checkFreeSpace(dir, filePath);
      if (spaceCheck.error) {
        return spaceCheck;
      }

      // 2. Copy file to temp location
      await fs.copyFile(filePath, tempFilePath);

      // 3. Write tags to temp copy via sidecar
      try {
        await this.tagWriter.write(tempFilePath, tagSet, opts);
      } catch (writeError) {
        await this.cleanup(tempFilePath);
        const message = writeError instanceof Error ? writeError.message : String(writeError);
        return { error: `write_failed: ${message}`, code: 'write_error' };
      }

      // 4. Re-read temp file with music-metadata and verify intended fields
      try {
        const reparseResult = await this.verifyFields(tempFilePath, tagSet);
        if (reparseResult.error) {
          await this.cleanup(tempFilePath);
          return reparseResult;
        }
      } catch (verifyError) {
        await this.cleanup(tempFilePath);
        const message = verifyError instanceof Error ? verifyError.message : String(verifyError);
        return { error: `verify_failed: ${message}`, code: 'verify_error' };
      }

      // 5. Hash compare - compute audio stream hash of temp file and verify equality
      let hashAfter: string;
      try {
        const ext = path.extname(filePath).toLowerCase().slice(1);
        hashAfter = await hashAudioStream(tempFilePath, ext);
      } catch (hashError) {
        await this.cleanup(tempFilePath);
        const message = hashError instanceof Error ? hashError.message : String(hashError);
        return { error: `hash_compute_failed: ${message}`, code: 'hash_error' };
      }

      if (hashAfter !== hashBefore) {
        await this.cleanup(tempFilePath);
        return { error: 'Audio-stream hash mismatch after write', code: 'hash_mismatch' };
      }

      // 6. Atomic rename - replace original with temp
      try {
        await fs.rename(tempFilePath, filePath);
      } catch (renameError) {
        await this.cleanup(tempFilePath);
        const message = renameError instanceof Error ? renameError.message : String(renameError);
        return { error: `rename_failed: ${message}`, code: 'rename_error' };
      }

      // 7. fsync directory to ensure rename is durable
      try {
        await this.fsyncDirectory(dir);
      } catch (fsyncError) {
        // Log but don't fail - rename already succeeded
        process.stderr.write(
          `[SafeFileWriter] Warning: fsync failed for ${dir}: ${fsyncError}\n`
        );
      }

      // Success
      return {};
    } catch (error) {
      // Catch-all for unexpected errors
      await this.cleanup(tempFilePath);
      const message = error instanceof Error ? error.message : String(error);
      return { error: `unexpected_error: ${message}`, code: 'error' };
    }
  }

  /**
   * Check if there is enough free space in the directory for a temp copy
   */
  private async checkFreeSpace(dir: string, originalPath: string): Promise<WriteResult> {
    try {
      const stats = await fs.stat(originalPath);
      const fileSize = stats.size ?? 0;

      // Get filesystem stats for the directory using statfs
      // statfs provides f_bavail (available blocks) and f_bsize (block size)
      // We need at least 'fileSize' bytes available
      return new Promise((resolve) => {
        statfs(dir, (err, statsfsResult) => {
          if (err) {
            const message = err instanceof Error ? err.message : String(err);
            return resolve({ error: `statfs_failed: ${message}`, code: 'space_error' });
          }

          // Calculate available space in bytes
          const availableBytes = statsfsResult.bavail * statsfsResult.bsize;

          // Check if we have enough space for the temporary copy
          if (availableBytes < fileSize) {
            return resolve({ error: 'Insufficient free space for temporary copy', code: 'no_space' });
          }

          resolve({});
        });
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { error: `space_check_failed: ${message}`, code: 'space_error' };
    }
  }

  /**
   * Re-read the temp file with music-metadata and verify intended fields match
   */
  private async verifyFields(tempFilePath: string, tagSet: TagSet): Promise<WriteResult> {
    try {
      // Re-read the temp file with the tag writer to get actual written tags
      const writtenTags = await this.tagWriter.read(tempFilePath);

      // Verify that the intended fields from tagSet are present in the written tags
      // We check each field that was supposed to be written
      for (const [field, intendedValue] of Object.entries(tagSet)) {
        if (intendedValue === undefined) {
          // Field was explicitly cleared (undefined means remove it)
          // We don't strictly verify absence, but we could check if field is not present
          continue;
        }

        const writtenValue = writtenTags[field];

        // Formats and the sidecar's read() differ on whether a single value
        // comes back as a string or a one-element list, so compare as sets of
        // strings (order may vary between tag formats too).
        const asList = (v: unknown): string[] =>
          v === undefined || v === null ? [] : Array.isArray(v) ? v.map(String) : [String(v)];
        const intended = new Set(asList(intendedValue));
        const written = new Set(asList(writtenValue));
        if (intended.size !== written.size || ![...intended].every((v) => written.has(v))) {
          return {
            error: `Field mismatch: ${field} - expected "${[...intended].join(' / ')}", got "${[...written].join(' / ')}"`,
            code: 'field_mismatch',
          };
        }
      }

      return {};
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { error: `reparse_failed: ${message}`, code: 'reparse_error' };
    }
  }

  /**
   * fsync directory to ensure durability of rename
   * Implementation: open directory, fsync file descriptor, close
   */
  private async fsyncDirectory(dirPath: string): Promise<void> {
    // In Node.js, we need to open the directory with fsOpen (callback API)
    // and use the callback-based fsync, then close the file descriptor
    // This is a async wrapper around the callback API
    return new Promise((resolve, reject) => {
      fsOpen(dirPath, 'r', (openErr, fd) => {
        if (openErr) {
          return reject(openErr);
        }

        // fsync the file descriptor to ensure durability
        fsync(fd, (fsyncErr) => {
          // Always close the file descriptor, even if fsync fails
          close(fd, (closeErr) => {
            if (fsyncErr) {
              return reject(fsyncErr);
            }
            if (closeErr) {
              return reject(closeErr);
            }
            resolve();
          });
        });
      });
    });
  }

  /**
   * Clean up temp file on error
   */
  private async cleanup(tempFilePath: string): Promise<void> {
    try {
      await fs.unlink(tempFilePath);
    } catch (error) {
      // Silently ignore cleanup errors
      process.stderr.write(`[SafeFileWriter] Warning: cleanup failed for ${tempFilePath}\n`);
    }
  }
}
