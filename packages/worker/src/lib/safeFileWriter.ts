/**
 * SafeFileWriter - Safe audio file tag writing with atomic rename and hash verification
 * Implements spec §12.6 TAG-4: temp copy → sidecar write → re-read → hash verify → atomic rename
 *
 * The steps live in `safeWriteSteps` so the file helper (fileHelper.ts) runs
 * the same ones inside its own process, behind the file gate.
 */

import { promises as fs, open as fsOpen, fsync, close } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { statfs } from 'node:fs';
import type { TagSet } from '@tagave/shared';
import { hashAudioStream } from '@tagave/core';
import type { TagWriter, WriteOptions } from '@tagave/core';
import { audioHandler, type FileTypeHandler } from '@tagave/core/files';

/**
 * Result from a write operation
 */
export interface WriteResult {
  error?: string;
  code?: string;
  /** The errno of the file call that failed (EIO, ENOSPC, ...), when one did. */
  errno?: string;
}

/** Test hooks between the steps (the helper's TAGAVE_HELPER_TEST_STOP_AFTER). */
export interface WriteStepHooks {
  /** Runs after the temp copy is made, before anything is written to it. */
  afterCopy?: () => Promise<void>;
}

interface Steps extends WriteStepHooks {
  write: (temp: string) => Promise<void>;
  verify: (temp: string) => Promise<WriteResult>;
  /** What the write must leave unchanged (audio: the audio-stream hash). */
  contentHash: (file: string) => Promise<string>;
  beforePublish?: () => Promise<void>;
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** A failed step's result, with the errno of the file call behind it when there is one. */
function failed(error: string, code: string, cause?: unknown): WriteResult {
  const errno = (cause as NodeJS.ErrnoException | undefined)?.code;
  return typeof errno === 'string' && errno !== '' ? { error, code, errno } : { error, code };
}

/**
 * Writes `values` to the file through `handler`, safely: hash before → free
 * space → temp copy → handler write → re-read and compare the fields → hash
 * compare → rename over the original (when it did not change meanwhile) →
 * fsync the folder. A failure at any step leaves the original untouched and
 * returns {error, code}; a cut-off run leaves the original or the new file,
 * plus at most a `.tagave-tmp-*` copy beside it.
 */
export async function safeWriteSteps(
  filePath: string,
  handler: FileTypeHandler,
  values: TagSet,
  writer: TagWriter,
  opts?: WriteOptions,
  hooks: WriteStepHooks = {},
): Promise<WriteResult> {
  const { write, contentHash } = handler;
  if (!write || !contentHash) return { error: `The ${handler.id} handler cannot write files`, code: 'not_writable' };
  return runWriteSteps(filePath, {
    ...hooks,
    write: (temp) => write(temp, values, writer, opts),
    verify: (temp) => verifyFields(writer, temp, values),
    contentHash: (file) => contentHash(file),
  });
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
    return safeWriteSteps(filePath, audioHandler, tagSet, this.tagWriter, opts);
  }

  async writeVerified(
    filePath: string,
    write: (temp: string) => Promise<void>,
    verify: (temp: string) => Promise<WriteResult>,
    beforePublish?: () => Promise<void>,
  ): Promise<WriteResult> {
    const ext = path.extname(filePath).toLowerCase().slice(1);
    const contentHash = (file: string) => hashAudioStream(file, ext);
    return runWriteSteps(filePath, beforePublish ? { write, verify, beforePublish, contentHash } : { write, verify, contentHash });
  }
}

async function runWriteSteps(filePath: string, steps: Steps): Promise<WriteResult> {
  const dir = path.dirname(filePath);
  const filename = path.basename(filePath);
  const tempFilename = `.tagave-tmp-${randomUUID()}${path.extname(filename)}`;
  const tempFilePath = path.join(dir, tempFilename);

  try {
    const original = await fs.lstat(filePath, { bigint: true });
    if (!original.isFile()) return { error: 'Expected a regular audio file', code: 'source_changed' };
    // 0. Compute audio-stream hash of original file
    let hashBefore: string;
    try {
      hashBefore = await steps.contentHash(filePath);
    } catch (hashError) {
      return failed(`hash_before_failed: ${messageOf(hashError)}`, 'hash_error', hashError);
    }

    // 1. Free-space precheck
    const spaceCheck = await checkFreeSpace(dir, filePath);
    if (spaceCheck.error) {
      return spaceCheck;
    }

    // 2. Copy file to temp location
    await fs.copyFile(filePath, tempFilePath);
    await steps.afterCopy?.();

    // 3. Write tags to temp copy via sidecar
    try {
      await steps.write(tempFilePath);
    } catch (writeError) {
      await cleanup(tempFilePath);
      return failed(`write_failed: ${messageOf(writeError)}`, 'write_error', writeError);
    }

    // 4. Re-read temp file with music-metadata and verify intended fields
    try {
      const reparseResult = await steps.verify(tempFilePath);
      if (reparseResult.error) {
        await cleanup(tempFilePath);
        return reparseResult;
      }
    } catch (verifyError) {
      await cleanup(tempFilePath);
      return failed(`verify_failed: ${messageOf(verifyError)}`, 'verify_error', verifyError);
    }

    // 5. Hash compare - compute audio stream hash of temp file and verify equality
    let hashAfter: string;
    try {
      hashAfter = await steps.contentHash(tempFilePath);
    } catch (hashError) {
      await cleanup(tempFilePath);
      return failed(`hash_compute_failed: ${messageOf(hashError)}`, 'hash_error', hashError);
    }

    if (hashAfter !== hashBefore) {
      await cleanup(tempFilePath);
      return { error: 'Audio-stream hash mismatch after write', code: 'hash_mismatch' };
    }

    // 6. Atomic rename - replace original with temp
    try {
      await steps.beforePublish?.();
      const current = await fs.lstat(filePath, { bigint: true });
      if (current.dev !== original.dev || current.ino !== original.ino || current.size !== original.size ||
          current.ctimeNs !== original.ctimeNs || current.mtimeNs !== original.mtimeNs) {
        throw new Error('Audio file changed while its tags were being written');
      }
      await fs.rename(tempFilePath, filePath);
    } catch (renameError) {
      await cleanup(tempFilePath);
      return failed(`rename_failed: ${messageOf(renameError)}`, 'rename_error', renameError);
    }

    // 7. fsync directory to ensure rename is durable
    try {
      await fsyncDirectory(dir);
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
    await cleanup(tempFilePath);
    return failed(`unexpected_error: ${messageOf(error)}`, 'error', error);
  }
}

/**
 * Check if there is enough free space in the directory for a temp copy
 */
async function checkFreeSpace(dir: string, originalPath: string): Promise<WriteResult> {
  try {
    const stats = await fs.stat(originalPath);
    const fileSize = stats.size ?? 0;

    // Get filesystem stats for the directory using statfs
    // statfs provides f_bavail (available blocks) and f_bsize (block size)
    // We need at least 'fileSize' bytes available
    return new Promise((resolve) => {
      statfs(dir, (err, statsfsResult) => {
        if (err) {
          return resolve(failed(`statfs_failed: ${messageOf(err)}`, 'space_error', err));
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
    return failed(`space_check_failed: ${messageOf(error)}`, 'space_error', error);
  }
}

/**
 * Re-read the temp file with music-metadata and verify intended fields match
 */
async function verifyFields(tagWriter: TagWriter, tempFilePath: string, tagSet: TagSet): Promise<WriteResult> {
  try {
    // Re-read the temp file with the tag writer to get actual written tags
    const writtenTags = await tagWriter.read(tempFilePath);

    // Verify that the intended fields from tagSet are present in the written tags
    // We check each field that was supposed to be written
    // Fields the write was asked to remove must be gone.
    const deletes = (tagSet as Record<string, unknown>)['__delete__'];
    for (const field of Array.isArray(deletes) ? deletes.map(String) : []) {
      const left = writtenTags[field];
      if (left !== undefined && left !== null && !(Array.isArray(left) && left.length === 0) && left !== '') {
        return { error: `Field mismatch: ${field} - expected it removed, got "${String(left)}"`, code: 'field_mismatch' };
      }
    }

    for (const [field, intendedValue] of Object.entries(tagSet)) {
      if (field.startsWith('__')) continue; // instructions, not fields
      if (intendedValue === undefined) {
        // Field was explicitly cleared (undefined means remove it)
        // We don't strictly verify absence, but we could check if field is not present
        continue;
      }

      const writtenValue = writtenTags[field];

      // Formats and the sidecar's read() differ on whether a single value
      // comes back as a string or a one-element list, so compare as sets of
      // strings (order may vary between tag formats too).
      // The sidecar reads the compilation flag back as a boolean.
      const one = (x: unknown): string => (x === true ? '1' : x === false ? '0' : String(x));
      const asList = (v: unknown): string[] =>
        v === undefined || v === null ? [] : Array.isArray(v) ? v.map(one) : [one(v)];
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
async function fsyncDirectory(dirPath: string): Promise<void> {
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
async function cleanup(tempFilePath: string): Promise<void> {
  try {
    await fs.unlink(tempFilePath);
  } catch (error) {
    // Silently ignore cleanup errors
    process.stderr.write(`[SafeFileWriter] Warning: cleanup failed for ${tempFilePath}\n`);
  }
}
