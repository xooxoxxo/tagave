/**
 * After a tag plan writes files, the player server (the bundled Navidrome or
 * the owner's own) must re-read them: its file watcher is off, because
 * inotify does not reach across NFS. This records the written folders and
 * queues the debounced player.scan job, which the app works (it holds the
 * player's credentials; the workers never do). It also forgets the cached
 * song ids of those files, since the server may give a re-read file a new id.
 *
 * Harmless when no player is set up: the app drops the requests.
 */
import { inArray, sql } from 'drizzle-orm';
import { localTracks, playerScanRequests, playerTrackMap } from '@liner/db';
import { folderOf, musicRelativePath } from '@liner/core/player';
import type { WorkerContext } from './context.js';

export const PLAYER_SCAN_QUEUE = 'player.scan';

export interface WrittenFile {
  libraryId: string;
  fileId: string;
  scanRootPath: string;
  relPath: string;
}

export function musicRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env['TAGAVE_MUSIC_ROOT']?.trim() || '/mnt/music';
}

/** The folders to scan per library, relative to the music root ('' when a file sits outside it). */
export function scanFoldersOf(files: readonly WrittenFile[], root = musicRoot()): Map<string, string[]> {
  const out = new Map<string, Set<string>>();
  for (const f of files) {
    const rel = musicRelativePath(root, f.scanRootPath, f.relPath);
    const folder = rel === null ? '' : folderOf(rel);
    if (!out.has(f.libraryId)) out.set(f.libraryId, new Set());
    out.get(f.libraryId)!.add(folder);
  }
  return new Map([...out].map(([lib, set]) => [lib, set.has('') ? [''] : [...set].sort()]));
}

export async function requestPlayerRescan(ctx: Pick<WorkerContext, 'db' | 'boss' | 'logger'>, files: readonly WrittenFile[]): Promise<void> {
  if (files.length === 0) return;
  try {
    const fileIds = [...new Set(files.map((f) => f.fileId))];
    await ctx.db.delete(playerTrackMap).where(inArray(
      playerTrackMap.localTrackId,
      ctx.db.select({ id: localTracks.id }).from(localTracks).where(inArray(localTracks.audioFileId, fileIds)),
    ));
    for (const [libraryId, folders] of scanFoldersOf(files)) {
      await ctx.db.insert(playerScanRequests)
        .values(folders.map((folder) => ({ libraryId, folder })))
        .onConflictDoUpdate({ target: [playerScanRequests.libraryId, playerScanRequests.folder], set: { requestedAt: sql`now()` } });
      await ctx.boss.send(PLAYER_SCAN_QUEUE, { libraryId }, { singletonKey: `${PLAYER_SCAN_QUEUE}:${libraryId}`, startAfter: 10 });
    }
  } catch (error) {
    // never fails the tag write: the nightly scan of the player catches up
    ctx.logger.warn({ error: String(error) }, 'tags.apply: could not ask the player to rescan');
  }
}
