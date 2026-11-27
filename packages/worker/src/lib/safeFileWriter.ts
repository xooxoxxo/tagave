/**
 * SafeFileWriter - Safe audio file tag writing with atomic rename and hash verification
 * Implements spec §12.6 TAG-4: temp copy → sidecar write → re-read → hash verify → atomic rename
 *
 * The steps themselves live in writeSteps.ts and run inside the file
 * helper's process (fileHelper.ts), behind the file gate. This class only
 * asks the gate: the worker makes no file call on the music share, and a
 * dead share throws FolderOfflineError for that root.
 */

import path from 'node:path';
import type { TagSet } from '@tagave/shared';
import type { WriteOptions } from '@tagave/core';
import { audioHandler } from '@tagave/core/files';
import { fileGate, type FileGate, type GateOp } from './fileGate.js';
import type { DirPage } from './fileHelper.js';
import { isGateFailure, isOfflineError } from './folderOffline.js';
import { tempPrefixFor, type PrepareResult, type WriteResult } from './writeSteps.js';

export { tempPrefixFor } from './writeSteps.js';
export type { CoverWriter, OriginalIdentity, PreparedWrite, PrepareResult, WriteResult, WriteStepHooks } from './writeSteps.js';

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * SafeFileWriter ensures tag writes never corrupt audio files
 * Uses atomic rename and hash verification per spec §12.6 TAG-4
 *
 * Every step runs in the file gate's helper (ops writeTagged, prepareTagged,
 * embedCover, prepareCover, publishPrepared) for the music folder `rootId`.
 */
export class SafeFileWriter {
  constructor(
    /** The scan root of every file this writer writes. */
    readonly rootId: string,
    private readonly gate: () => FileGate = fileGate,
  ) {}

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
    opts?: WriteOptions,
    /** Runs after the temp copy is verified, right before the rename; a throw leaves the original. */
    beforePublish?: () => Promise<void>,
  ): Promise<WriteResult> {
    const options = opts ? { options: opts } : {};
    if (!beforePublish) {
      return this.gate().run<WriteResult>(this.rootId, { op: 'writeTagged', path: filePath, handlerId: audioHandler.id, values: tagSet, ...options });
    }
    return this.inTwoSteps(filePath, { op: 'prepareTagged', path: filePath, handlerId: audioHandler.id, values: tagSet, ...options }, beforePublish);
  }

  /**
   * Embeds `image` as the front cover, safely, through the file gate. With
   * `beforePublish` the write runs in two gate calls (prepare, then publish)
   * and the check runs in the worker between them, right before the rename.
   */
  async embedCover(filePath: string, image: Buffer, beforePublish?: () => Promise<void>): Promise<WriteResult> {
    if (!beforePublish) return this.gate().run<WriteResult>(this.rootId, { op: 'embedCover', path: filePath, image });
    return this.inTwoSteps(filePath, { op: 'prepareCover', path: filePath, image }, beforePublish);
  }

  /**
   * Prepare (the temp copy written, verified and synced in the helper), the
   * worker's own check, then publish (the rename in the helper). A check
   * that fails removes the temp copy through the gate and leaves the
   * original; an offline folder or a failed gate rethrows, and the temp copy
   * a cut-off run leaves is removed on the retry (ruling R9).
   */
  private async inTwoSteps(filePath: string, prepare: GateOp, beforePublish: () => Promise<void>): Promise<WriteResult> {
    const rootId = this.rootId;
    const gate = this.gate();
    const r = await gate.run<PrepareResult>(rootId, prepare);
    if (!r.prepared) return r;
    try {
      await beforePublish();
    } catch (err) {
      if (isOfflineError(err) || isGateFailure(err)) throw err;
      await gate.run(rootId, { op: 'unlink', path: r.prepared.temp }).catch(() => undefined);
      return { error: `rename_failed: ${messageOf(err)}`, code: 'rename_error' };
    }
    return gate.run<WriteResult>(rootId, { op: 'publishPrepared', path: filePath, prepared: r.prepared });
  }

  /**
   * Removes the temp copies a cut-off write of this file left beside it
   * (ruling R9), through the file gate. Returns how many went.
   */
  async removeStaleTemps(filePath: string): Promise<number> {
    const gate = this.gate();
    const dir = path.dirname(filePath);
    const prefix = tempPrefixFor(filePath);
    const stale: string[] = [];
    let cursor: string | null = null;
    do {
      const page: DirPage = await gate.run<DirPage>(this.rootId, { op: 'readdirPage', path: dir, cursor });
      for (const e of page.entries) if (e.type === 'file' && e.name.startsWith(prefix)) stale.push(path.join(dir, e.name));
      cursor = page.cursor;
    } while (cursor !== null);
    for (const file of stale) await gate.run(this.rootId, { op: 'unlink', path: file });
    return stale.length;
  }
}
