/**
 * After a tag plan writes files, the player server (the bundled Navidrome or
 * the owner's own) must re-read them: its file watcher is off, because
 * inotify does not reach across NFS. This records the written folders and
 * queues the debounced player.scan job, which the app works (it holds the
 * player's credentials; the workers never do). It also forgets the cached
 * song ids of those files, since the server may give a re-read file a new id.
 *
 * Harmless when no player is set up: the app drops the requests.
 *
 * While any music folder is not online (offline or not connected) no
 * player.scan is sent: the player server would walk the dead share too, and
 * read every file on it as gone. The requests are kept (player_scan_requests)
 * and go once the folder is back: the watch's return (`onlineAgain`) adds the
 * root's own folder (`holdForReturn`), and the return scan's end
 * (`afterReturn`, from scan.root) sends one player.scan per library waiting.
 */
import { inArray, sql } from 'drizzle-orm';
import { localTracks, playerScanRequests, playerTrackMap } from '@tagave/db';
import { folderOf, musicRelativePath } from '@tagave/core/player';
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

/**
 * Rows per statement: inArray and multi-row values bind one parameter per
 * item, and Postgres takes at most 65535 in one statement (a whole-library
 * reorganise moves far more files than that).
 */
export const RESCAN_BATCH = 5000;

/** A root's own folder relative to the music root ('' when it is the music root, or outside it: the whole library). */
export function rootFolderOf(scanRootPath: string, root = musicRoot()): string {
  const rel = musicRelativePath(root, scanRootPath, '_');
  return rel === null ? '' : folderOf(rel);
}

/** Some enabled music folder is not online (offline or not connected): no player.scan goes meanwhile. */
export async function anyRootNotOnline(ctx: Pick<WorkerContext, 'sql'>): Promise<boolean> {
  const [row] = await ctx.sql<{ held: boolean }[]>`
    select exists (select 1 from scan_roots where enabled and reach in ('offline', 'unmounted')) as held`;
  return row?.held === true;
}

function sendPlayerScan(ctx: Pick<WorkerContext, 'boss'>, libraryId: string) {
  return ctx.boss.send(PLAYER_SCAN_QUEUE, { libraryId }, { singletonKey: `${PLAYER_SCAN_QUEUE}:${libraryId}`, startAfter: 10 });
}

export async function requestPlayerRescan(ctx: Pick<WorkerContext, 'db' | 'sql' | 'boss' | 'logger'>, files: readonly WrittenFile[]): Promise<void> {
  if (files.length === 0) return;
  try {
    const fileIds = [...new Set(files.map((f) => f.fileId))];
    for (let i = 0; i < fileIds.length; i += RESCAN_BATCH) {
      await ctx.db.delete(playerTrackMap).where(inArray(
        playerTrackMap.localTrackId,
        ctx.db.select({ id: localTracks.id }).from(localTracks).where(inArray(localTracks.audioFileId, fileIds.slice(i, i + RESCAN_BATCH))),
      ));
    }
    // a music folder not online: the requests wait for its return scan (afterReturn)
    const held = await anyRootNotOnline(ctx);
    for (const [libraryId, folders] of scanFoldersOf(files)) {
      for (let i = 0; i < folders.length; i += RESCAN_BATCH) {
        await ctx.db.insert(playerScanRequests)
          .values(folders.slice(i, i + RESCAN_BATCH).map((folder) => ({ libraryId, folder })))
          .onConflictDoUpdate({ target: [playerScanRequests.libraryId, playerScanRequests.folder], set: { requestedAt: sql`now()` } });
      }
      if (!held) await sendPlayerScan(ctx, libraryId);
    }
  } catch (error) {
    // never fails the tag write: the nightly scan of the player catches up
    ctx.logger.warn({ error: String(error) }, 'tags.apply: could not ask the player to rescan');
  }
}

/**
 * The watch saw the root come back (onlineAgain): its own folder is asked
 * for, held until its return scan ends (afterReturn). Nothing is sent here.
 */
export async function holdForReturn(ctx: Pick<WorkerContext, 'sql'>, rootId: string): Promise<void> {
  const [root] = await ctx.sql<{ libraryId: string; path: string }[]>`
    select library_id::text as "libraryId", path from scan_roots where id = ${rootId}`;
  if (!root) return;
  await ctx.sql`
    insert into player_scan_requests (library_id, folder) values (${root.libraryId}, ${rootFolderOf(root.path)})
    on conflict (library_id, folder) do update set requested_at = now()`;
}

/**
 * A scan of the root ended (scan.root). When it is the return scan (the
 * root's latest, completed whole with no `stats.offline`, and the first such
 * since the root's reach last changed to online) and every music folder is
 * online, one player.scan goes for each library with requests waiting.
 * Later scans send nothing here: once per return. True when one went.
 */
export async function afterReturn(ctx: Pick<WorkerContext, 'sql' | 'boss' | 'logger'>, rootId: string): Promise<boolean> {
  const [scan] = await ctx.sql<{ status: string; offline: boolean; first: boolean }[]>`
    select s.status, coalesce((s.stats ->> 'offline')::boolean, false) as offline,
           (sr.reach = 'online' and sr.reach_since is not null and s.started_at >= sr.reach_since
            and not exists (
              select 1 from scans o
               where o.scan_root_id = s.scan_root_id and o.id <> s.id and o.status = 'completed'
                 and o.started_at >= sr.reach_since and o.started_at <= s.started_at
                 and not coalesce((o.stats ->> 'offline')::boolean, false))) as first
      from scans s join scan_roots sr on sr.id = s.scan_root_id
     where s.scan_root_id = ${rootId} order by s.started_at desc limit 1`;
  if (!scan || scan.status !== 'completed' || scan.offline || !scan.first) return false;
  if (await anyRootNotOnline(ctx)) return false;
  const waiting = await ctx.sql<{ libraryId: string }[]>`
    select distinct library_id::text as "libraryId" from player_scan_requests`;
  for (const { libraryId } of waiting) await sendPlayerScan(ctx, libraryId);
  if (waiting.length > 0) ctx.logger.info({ scanRootId: rootId, libraries: waiting.length }, 'player scan sent: music folder back online');
  return waiting.length > 0;
}
