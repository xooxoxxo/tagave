/**
 * Deleting songs and albums on the file worker (0073 file_deletions; vault
 * "tagave - Deleting Songs and Albums").
 *
 * Trash: a file moves into `<root>/.tagave-trash/<YYYY-MM-DD>/<relative path>`
 * by rename(2) only, so it never leaves its filesystem: a rename that would
 * cross devices is refused and the file is marked instead (the owner deletes
 * it with the Marked list's command). The trash folder holds a `.ndignore`, so
 * Navidrome skips it, and every scan skips it as a dot folder.
 *
 * Drop: once a deleted file is really gone (the scan no longer finds a marked
 * file, Empty trash, 30 days) its file row is deleted, which takes its tracks
 * and what hangs off them; an album left with no tracks goes too. No 24 h
 * hold: the owner asked for exactly this deletion.
 *
 * Every file call goes through the file gate (fileGate.ts). A music folder
 * that goes offline stops the action for that folder: its rows stay as they
 * are (moving, restoring, trashed), nothing is marked, dropped or recorded
 * as failed, and the next run (the daily one, or the owner's) takes them up.
 */
import path from 'node:path';
import { albumKeyLock, rootReach, updateMaintenanceTask, type MaintenanceWork } from '@tagave/db';
import { TRASH_DAYS, TRASH_DIR } from '@tagave/shared';
import type { WorkerContext } from './context.js';
import { refreshAlbumCounters } from '../jobs/clusterDir.js';
import { fileGate } from './fileGate.js';
import { fileStat, insideRoot, mountIdentity } from './fileRecovery.js';
import { FolderOfflineError, isAbsent, isGateFailure, isOfflineError } from './folderOffline.js';
import { gateDirEmpty, gateExists, gateLstat, gateOnDisk, gateStat } from './gatedPaths.js';
import { runMaintenance, type MaintenanceRun } from './maintenance.js';
import { albumsChanged } from './albumCare.js';

/** An answer that says nothing about the file: the folder is offline, or the gate failed. Never a reason to mark, drop or fail. */
export const unanswered = (err: unknown): boolean => isOfflineError(err) || isGateFailure(err);

const BATCH = 1000;

/** The trash folder's .ndignore: Navidrome leaves the folder (and all below it) out. */
export const NDIGNORE = '.ndignore';

/** Ask facets.refresh to rebuild the rail and the artists list: albums came and went. */
export async function markLibraryDirty(ctx: Pick<WorkerContext, 'sql' | 'boss' | 'logger'>, libraryId: string): Promise<void> {
  await ctx.sql`
    insert into filter_rail_state (library_id, dirty_at) values (${libraryId}, now())
    on conflict (library_id) do update set dirty_at = now()`;
  try {
    await ctx.boss.send('facets.refresh', { libraryId }, { singletonKey: `facets:${libraryId}` });
  } catch (err) {
    ctx.logger.warn({ err: (err as Error).message }, 'deletions: could not ask for a facets refresh');
  }
}

/**
 * Deletes the file rows of these deleted files (only files that still have a
 * deletion row: a file the owner unmarked meanwhile stays) and the albums
 * that are left without a track. Each album goes under its key lock with its
 * emptiness checked again, as cluster.dir's sweep does.
 */
export async function dropDeletedFiles(ctx: Pick<WorkerContext, 'sql' | 'boss' | 'logger'>, fileIds: readonly string[]): Promise<{ dropped: number; albumsRemoved: number }> {
  if (fileIds.length === 0) return { dropped: 0, albumsRemoved: 0 };
  let dropped = 0;
  const albums = new Map<string, { libraryId: string; clusterKey: string }>();
  const libraries = new Set<string>();
  for (let i = 0; i < fileIds.length; i += BATCH) {
    const chunk = fileIds.slice(i, i + BATCH);
    const touched = (await ctx.sql`
      select distinct la.id::text as id, la.library_id::text as "libraryId", la.cluster_key as "clusterKey"
        from local_tracks lt join local_albums la on la.id = lt.local_album_id
       where lt.audio_file_id = any(${chunk}::uuid[])`) as unknown as Array<{ id: string; libraryId: string; clusterKey: string }>;
    for (const a of touched) albums.set(a.id, a);
    const gone = (await ctx.sql`
      delete from files f
       where f.id = any(${chunk}::uuid[])
         and exists (select 1 from file_deletions fd where fd.file_id = f.id)
      returning f.library_id::text as "libraryId"`) as unknown as Array<{ libraryId: string }>;
    dropped += gone.length;
    for (const g of gone) libraries.add(g.libraryId);
  }
  let albumsRemoved = 0;
  const left: string[] = [];
  for (const [id, a] of albums) {
    const removed = (await ctx.sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${albumKeyLock(a.libraryId, a.clusterKey)}, 0))`;
      return tx`
        delete from local_albums la
         where la.id = ${id} and not exists (select 1 from local_tracks lt where lt.local_album_id = la.id)
        returning la.id`;
    })) as unknown as unknown[];
    if (removed.length > 0) albumsRemoved++;
    else left.push(id);
  }
  await refreshAlbumCounters(ctx, left);
  for (const libraryId of libraries) await markLibraryDirty(ctx, libraryId);
  // Library care: the albums that lost songs (or went) are rechecked
  const byLibrary = new Map<string, string[]>();
  for (const [id, a] of albums) byLibrary.set(a.libraryId, [...(byLibrary.get(a.libraryId) ?? []), id]);
  for (const [libraryId, ids] of byLibrary) await albumsChanged(ctx, libraryId, ids);
  return { dropped, albumsRemoved };
}

/** `YYYY-MM-DD` of the day, UTC: the trash folder's day folder. */
export const trashDay = (d: Date): string => d.toISOString().slice(0, 10);

/** The relative path a file moves to: `.tagave-trash/<day>/<its relative path>`. */
export function trashRelPath(relPath: string, day: string): string {
  return `${TRASH_DIR}/${day}/${relPath}`;
}

/** True when something is at the path (through the gate). Offline and gate failures throw. */
export async function exists(rootId: string, p: string): Promise<boolean> {
  return gateExists(rootId, p);
}

/** The path on disk of a relative path, trying the NFC and NFD spellings (the archive mixes them). */
export async function onDisk(rootId: string, root: string, relPath: string): Promise<string | null> {
  return gateOnDisk(rootId, root, relPath);
}

/** mkdir -p through the gate: the first folder it made, or null when all were there. */
export async function makeDirs(rootId: string, abs: string): Promise<string | null> {
  return fileGate().run<string | null>(rootId, { op: 'mkdir', path: abs, recursive: true });
}

/** rename(2) through the gate. */
export async function renamePath(rootId: string, from: string, to: string): Promise<void> {
  await fileGate().run(rootId, { op: 'rename', from, to });
}

/** The root's trash folder with its .ndignore, made when missing. */
export async function ensureTrashDir(rootId: string, root: string): Promise<string> {
  const dir = path.join(root, TRASH_DIR);
  await makeDirs(rootId, dir);
  if (!(await fileStat(rootId, dir))?.isDirectory) throw new Error('The Trash folder is not a directory');
  const ignore = path.join(dir, NDIGNORE);
  if (!(await fileStat(rootId, ignore))) {
    await fileGate().run(rootId, { op: 'writeSmall', path: ignore, data: new Uint8Array(0), exclusive: true }).catch((err: unknown) => {
      if ((err as { code?: unknown }).code !== 'EEXIST') throw err;
    });
  }
  if (!(await fileStat(rootId, ignore))?.isFile) throw new Error('The Trash marker is not a regular file');
  return dir;
}

type Outcome = 'trashed' | 'marked' | 'gone';

/**
 * Moves one file into its root's trash. 'marked' when it cannot (another
 * filesystem, no write access): the row becomes a mark with the reason.
 * An offline folder or a failed gate throws: that is no answer about the file.
 */
export async function trashOne(rootId: string, root: string, relPath: string, day: string): Promise<{ outcome: Outcome; trashRelPath?: string; trashMount?: string; error?: string }> {
  const src = await onDisk(rootId, root, relPath);
  if (!src) return { outcome: 'gone' };
  try {
    const trashMount = await mountIdentity(rootId, root);
    const trashDir = await ensureTrashDir(rootId, root);
    const [from, into] = await Promise.all([gateStat(rootId, src), gateStat(rootId, trashDir)]);
    if (!from) return { outcome: 'gone' };
    if (!into || String(from.dev) !== String(into.dev)) return { outcome: 'marked', error: 'On another disk than its music folder' };
    let rel = trashRelPath(relPath, day);
    // the same path trashed twice in a day: the later one gets a numbered day folder
    for (let n = 2; await exists(rootId, path.join(root, rel)); n++) rel = trashRelPath(relPath, `${day}-${n}`);
    const dest = path.join(root, rel);
    await insideRoot(rootId, root, src);
    await insideRoot(rootId, trashDir, dest);
    await makeDirs(rootId, path.dirname(dest));
    await renamePath(rootId, src, dest);
    return { outcome: 'trashed', trashRelPath: rel, trashMount };
  } catch (err) {
    if (unanswered(err)) throw err;
    const code = (err as NodeJS.ErrnoException).code;
    // gone only when the file itself is: an ENOENT of another path (a realpath on the way) is no proof
    if (code === 'ENOENT') {
      if (!(await gateLstat(rootId, src))) return { outcome: 'gone' };
      return { outcome: 'marked', error: (err as Error).message };
    }
    return { outcome: 'marked', error: code === 'EXDEV' ? 'On another disk than its music folder' : code === 'EACCES' || code === 'EPERM' || code === 'EROFS' ? 'The music folder is read-only' : (err as Error).message };
  }
}

interface Row { fileId: string; libraryId: string; rootId: string; root: string; relPath: string; trashRelPath: string | null; trashMount: string | null }

/**
 * The music folders that went offline during one run: their later rows are
 * left for the next run, untouched. A failed gate counts the same (nothing
 * is known about the folder).
 */
class OfflineRoots {
  private readonly roots = new Set<string>();
  first: unknown = null;
  has(rootId: string): boolean {
    return this.roots.has(rootId);
  }
  /** True when the error is the folder's (offline) or the gate's: the row is left as it is. */
  take(ctx: Pick<WorkerContext, 'logger'>, rootId: string, err: unknown, what: string): boolean {
    if (!unanswered(err)) return false;
    this.roots.add(rootId);
    this.first ??= err;
    ctx.logger.warn({ scanRootId: rootId, err: (err as Error).message }, `files.trash: ${what} paused, the music folder is offline`);
    return true;
  }
  get size(): number {
    return this.roots.size;
  }
  private readonly checked = new Map<string, boolean>();
  /**
   * Before a row may read "gone": the root is connected (rootConnected).
   * Asked once per root and run. False, or an offline answer: the root's
   * rows wait as they are, with no error, and nothing is dropped.
   */
  async connected(ctx: Pick<WorkerContext, 'sql' | 'logger'>, rootId: string, root: string): Promise<boolean> {
    if (this.roots.has(rootId)) return false;
    const known = this.checked.get(rootId);
    if (known !== undefined) return known;
    let ok: boolean;
    try {
      ok = await rootConnected(ctx, rootId, root);
    } catch (err) {
      if (!this.take(ctx, rootId, err, 'the check of the music folder')) throw err;
      return false;
    }
    this.checked.set(rootId, ok);
    if (!ok) {
      this.roots.add(rootId);
      ctx.logger.warn({ scanRootId: rootId }, 'files.trash: paused, the music folder is not connected');
    }
    return ok;
  }
}

/**
 * The root is there to answer for its files: its reach is not offline or
 * not connected, and its folder is there and holds something. A share that
 * is not connected leaves an empty folder (or none) where it was mounted,
 * and every file in it would read as gone (PR1's not-connected rule).
 * Offline and gate failures throw.
 */
export async function rootConnected(ctx: Pick<WorkerContext, 'sql'>, rootId: string, root: string): Promise<boolean> {
  const { reach } = await rootReach(ctx.sql, rootId);
  if (reach === 'offline' || reach === 'unmounted') return false;
  try {
    return !(await gateDirEmpty(rootId, root));
  } catch (err) {
    if (isAbsent(err)) return false;
    throw err;
  }
}

/** What one trash run takes up. `onlineOnly` (the daily sweep): no row of a root that is not online (offline or not connected). */
interface RunScope { olderThanDays?: number; onlineOnly?: boolean }

async function rowsIn(ctx: Pick<WorkerContext, 'sql'>, libraryId: string | null, state: string, scope: RunScope = {}): Promise<Row[]> {
  const { olderThanDays } = scope;
  return (await ctx.sql`
    select fd.file_id::text as "fileId", fd.library_id::text as "libraryId", fd.scan_root_id::text as "rootId", sr.path as root,
           fd.rel_path as "relPath", fd.trash_rel_path as "trashRelPath", fd.trash_mount as "trashMount"
      from file_deletions fd join scan_roots sr on sr.id = fd.scan_root_id
     where fd.kind = 'trash' and fd.state = ${state}
       and (${libraryId}::uuid is null or fd.library_id = ${libraryId}::uuid)
       and fd.purge_task_id is null
       and (${olderThanDays ?? null}::int is null or fd.trashed_at < now() - make_interval(days => ${olderThanDays ?? 0}))
       and (not ${scope.onlineOnly === true}::boolean or sr.reach not in ('offline', 'unmounted'))
     order by fd.created_at`) as unknown as Row[];
}

export type TrashCounts = { trashed: number; marked: number; dropped: number; paused?: number };

/**
 * Every file waiting to go into the trash ('moving'). A music folder that is
 * offline keeps its rows waiting (`paused` counts them); with `throwOffline`
 * the first offline answer throws instead (an import's Replace waits for it).
 * With `onlineOnly` (the daily sweep) a root that is not online is not even
 * looked at: its rows wait, with no line in the log.
 */
export async function moveWaiting(ctx: WorkerContext, libraryId: string | null, now = new Date(), opts: { throwOffline?: boolean; onlineOnly?: boolean } = {}): Promise<TrashCounts> {
  const rows = await rowsIn(ctx, libraryId, 'moving', { onlineOnly: opts.onlineOnly ?? false });
  const day = trashDay(now);
  let trashed = 0;
  let marked = 0;
  let paused = 0;
  const offline = new OfflineRoots();
  const gone: string[] = [];
  for (const r of rows) {
    // a root not connected would read every file as gone: its rows wait
    if (!(await offline.connected(ctx, r.rootId, r.root))) {
      if (opts.throwOffline) {
        await dropDeletedFiles(ctx, gone);
        throw offline.first ?? new FolderOfflineError(r.rootId, 'not_mounted');
      }
      paused++;
      continue;
    }
    let out: Awaited<ReturnType<typeof trashOne>>;
    try {
      out = await trashOne(r.rootId, r.root, r.relPath, day);
    } catch (err) {
      if (!offline.take(ctx, r.rootId, err, 'the move into the trash')) throw err;
      if (opts.throwOffline) { await dropDeletedFiles(ctx, gone); throw err; }
      paused++;
      continue;
    }
    if (out.outcome === 'trashed') {
      trashed++;
      await ctx.sql`update file_deletions set state = 'trashed', trash_rel_path = ${out.trashRelPath!}, trash_mount = ${out.trashMount ?? null}, trashed_at = now(), error = null
                     where file_id = ${r.fileId} and state = 'moving'`;
    } else if (out.outcome === 'marked') {
      marked++;
      ctx.logger.warn({ fileId: r.fileId, error: out.error }, 'files.trash: kept in place and marked');
      await ctx.sql`update file_deletions set kind = 'mark', state = 'marked', error = ${out.error ?? null}
                     where file_id = ${r.fileId} and state = 'moving'`;
    } else {
      gone.push(r.fileId);
    }
  }
  const { dropped } = await dropDeletedFiles(ctx, gone);
  return { trashed, marked, dropped, ...(paused > 0 ? { paused } : {}) };
}

/**
 * Every file waiting to come back ('restoring'): renamed to where it was, unless that place is taken. An offline folder keeps its rows waiting.
 * With `onlineOnly` (the daily sweep) a root that is not online is not even looked at.
 */
export async function restoreWaiting(ctx: WorkerContext, libraryId: string | null, opts: { onlineOnly?: boolean } = {}): Promise<{ restored: number; refused: number; dropped: number; paused?: number }> {
  const rows = await rowsIn(ctx, libraryId, 'restoring', { onlineOnly: opts.onlineOnly ?? false });
  let restored = 0;
  let refused = 0;
  let paused = 0;
  const offline = new OfflineRoots();
  const gone: string[] = [];
  const libs = new Set<string>();
  const back: string[] = [];
  for (const r of rows) {
    if (!(await offline.connected(ctx, r.rootId, r.root))) { paused++; continue; }
    // the trash it went into is this mount's: another mount (or a share not connected) would read the copy as gone
    if (r.trashMount) {
      let mount: string | null;
      try {
        mount = await mountIdentity(r.rootId, r.root);
      } catch (err) {
        if (!unanswered(err)) ctx.logger.warn({ fileId: r.fileId, err: (err as Error).message }, 'files.trash: Restore waits, the music folder is unavailable');
        else offline.take(ctx, r.rootId, err, 'Restore');
        mount = null;
      }
      if (mount !== r.trashMount) {
        if (mount !== null) ctx.logger.warn({ fileId: r.fileId }, 'files.trash: Restore waits, the trash is on another mount');
        paused++;
        continue;
      }
    }
    let src: string | null = null;
    const dest = path.join(r.root, r.relPath);
    try {
      src = r.trashRelPath ? await onDisk(r.rootId, r.root, r.trashRelPath) : null;
      if (!src) { gone.push(r.fileId); continue; }
      if (await exists(r.rootId, dest)) {
        refused++;
        await ctx.sql`update file_deletions set state = 'trashed', error = 'Another file is in its place' where file_id = ${r.fileId}`;
        continue;
      }
      await makeDirs(r.rootId, path.dirname(dest));
      await renamePath(r.rootId, src, dest);
    } catch (err) {
      if (offline.take(ctx, r.rootId, err, 'Restore')) { paused++; continue; }
      refused++;
      await ctx.sql`update file_deletions set state = 'trashed', error = ${(err as Error).message} where file_id = ${r.fileId}`;
      continue;
    }
    restored++;
    libs.add(r.libraryId);
    back.push(r.fileId);
    await ctx.sql`delete from file_deletions where file_id = ${r.fileId}`;
    await removeEmptyDirs(r.rootId, r.root, path.dirname(src!));
  }
  for (const l of libs) await markLibraryDirty(ctx, l);
  // Library care: a restored album has its problems again
  if (back.length > 0) {
    const albums = (await ctx.sql`
      select distinct la.id::text as id, la.library_id::text as "libraryId"
        from local_tracks lt join local_albums la on la.id = lt.local_album_id
       where lt.audio_file_id = any(${back}::uuid[])`) as unknown as Array<{ id: string; libraryId: string }>;
    for (const l of new Set(albums.map((a) => a.libraryId))) {
      await albumsChanged(ctx, l, albums.filter((a) => a.libraryId === l).map((a) => a.id));
    }
  }
  const { dropped } = await dropDeletedFiles(ctx, gone);
  return { restored, refused, dropped, ...(paused > 0 ? { paused } : {}) };
}

/** Removes empty folders from `dir` up to the trash folder (never the trash folder itself). Best effort: any trouble leaves them. */
async function removeEmptyDirs(rootId: string, root: string, dir: string): Promise<void> {
  const top = path.join(root, TRASH_DIR);
  for (let d = dir; d.startsWith(top + path.sep); d = path.dirname(d)) {
    try {
      if (!(await gateDirEmpty(rootId, d))) return;
      await fileGate().run(rootId, { op: 'rmdir', path: d });
    } catch {
      return;
    }
  }
}

async function checkedTrash(rootId: string, root: string): Promise<{ mount: string; dir: string }> {
  const mount = await mountIdentity(rootId, root).catch((err: unknown) => {
    if (unanswered(err)) throw err;
    throw new Error('The music folder is unavailable. Check the mount.');
  });
  const dir = path.join(root, TRASH_DIR);
  if (!(await fileStat(rootId, dir))?.isDirectory || !(await fileStat(rootId, path.join(dir, NDIGNORE)))?.isFile) {
    throw new Error('The music folder’s Trash is unavailable. Check the mount.');
  }
  const [a, b] = await Promise.all([gateStat(rootId, root), gateStat(rootId, dir)]);
  if (!a || !b || String(a.dev) !== String(b.dev)) throw new Error('Trash is on a different mount.');
  return { mount, dir };
}

async function checkedTrashFile(rootId: string, dir: string, rel: string | null): Promise<string> {
  if (!rel?.startsWith(TRASH_DIR + '/') || rel.split('/').some((segment) => !segment || segment === '..' || segment === '.')) {
    throw new Error('The file has no valid Trash path.');
  }
  const root = path.dirname(dir);
  for (const name of new Set([rel, rel.normalize('NFD'), rel.normalize('NFC')])) {
    const file = path.join(root, name);
    const info = await fileStat(rootId, file);
    if (!info) continue;
    await insideRoot(rootId, dir, file);
    const trash = await gateStat(rootId, dir);
    if (!info.isFile || !trash || String(info.dev) !== String(trash.dev)) throw new Error('The Trash file changed or is on another mount.');
    return file;
  }
  throw new Error('The selected file is missing from Trash.');
}

async function cleanPurged(ctx: WorkerContext, libraryId: string | null): Promise<number> {
  const rows = await ctx.sql<{ id: string }[]>`
    select file_id as id from file_deletions where state = 'purged'
      and (${libraryId}::uuid is null or library_id = ${libraryId}::uuid)`;
  return (await dropDeletedFiles(ctx, rows.map((row) => row.id))).dropped;
}

/** Scheduled cleanup locks an eligible row against Restore and a manual purge. With `onlineOnly` a root that is not online is not looked at. */
export async function emptyTrash(ctx: WorkerContext, libraryId: string | null, olderThanDays?: number, opts: { onlineOnly?: boolean } = {}): Promise<{ deleted: number; failed: number }> {
  const rows = await rowsIn(ctx, libraryId, 'trashed', { ...(olderThanDays !== undefined ? { olderThanDays } : {}), onlineOnly: opts.onlineOnly ?? false });
  let failed = 0;
  const offline = new OfflineRoots();
  for (const r of rows) {
    if (offline.has(r.rootId)) continue;
    try {
      await ctx.sql.begin(async (tx) => {
        const [locked] = await tx`select fd.file_id from file_deletions fd join scan_roots sr on sr.id = fd.scan_root_id
          where fd.file_id = ${r.fileId} and fd.state = 'trashed' and fd.purge_task_id is null
            and fd.trash_rel_path = ${r.trashRelPath} and sr.path = ${r.root} for update of fd skip locked`;
        if (!locked) return;
        const { dir, mount } = await checkedTrash(r.rootId, r.root);
        if (r.trashMount && r.trashMount !== mount) throw new Error('The Trash mount changed.');
        const file = await checkedTrashFile(r.rootId, dir, r.trashRelPath);
        await fileGate().run(r.rootId, { op: 'unlink', path: file });
        await tx`update file_deletions set state = 'purged' where file_id = ${r.fileId}`;
        await removeEmptyDirs(r.rootId, r.root, path.dirname(file));
      });
    } catch (err) {
      // offline: the row stays trashed with no error, for the next day's run
      if (offline.take(ctx, r.rootId, err, 'Empty trash')) continue;
      failed++;
      await ctx.sql`update file_deletions set error = ${(err as Error).message}
        where file_id = ${r.fileId} and state = 'trashed' and purge_task_id is null`;
    }
  }
  return { deleted: await cleanPurged(ctx, libraryId), failed };
}

interface PurgeFlight {
  id: string;
  mount: string;
  file: string;
  fingerprint: string;
}
type PurgeCheckpoint = { index: number; inFlight?: PurgeFlight };
type PurgeRow = { rootId: string; root: string; trash: string | null; trashMount: string | null };

async function fingerprint(rootId: string, file: string): Promise<string | null> {
  const info = await fileStat(rootId, file);
  if (!info) return null;
  if (!info.isFile) throw new Error('The Trash path is no longer a regular file.');
  return JSON.stringify([Number(info.dev), Number(info.ino), Number(info.size), Number(info.mtimeMs)]);
}

/**
 * Empty Trash of a confirmed selection. A music folder that goes offline
 * throws FolderOfflineError out of the run: runMaintenance pauses the task
 * for the owner's Continue, its checkpoint (the index, the file in flight)
 * kept (Decision 2).
 */
async function purgeSelected(ctx: WorkerContext, work: MaintenanceWork, claim: MaintenanceRun) {
  const { row } = claim;
  const selection = row.input.fileIds as string[] | undefined;
  if (!selection?.length) throw new Error('No confirmed Trash selection.');
  const checkpoint = row.checkpoint as PurgeCheckpoint | null;
  const total = selection.length;
  let index = checkpoint?.index ?? 0;
  await claim.update({ stage: 'Emptying Trash', progress: { done: index, total } });
  while (index < total) {
    const id = selection[index]!;
    let flight = checkpoint?.inFlight?.id === id ? checkpoint.inFlight : undefined;
    if ((await claim.current()).cancel_requested && !flight) break;
    if (!flight) {
      const [selected] = await ctx.sql<PurgeRow[]>`
        select fd.scan_root_id::text as "rootId", sr.path as root, fd.trash_rel_path as trash, fd.trash_mount as "trashMount"
          from file_deletions fd join scan_roots sr on sr.id = fd.scan_root_id
        where fd.file_id = ${id} and fd.purge_task_id = ${row.id} and fd.state = 'trashed' and sr.writable`;
      if (!selected) throw new Error('A selected Trash entry or its writable music folder changed.');
      const { mount, dir } = await checkedTrash(selected.rootId, selected.root);
      if (selected.trashMount && selected.trashMount !== mount) throw new Error('The Trash mount changed.');
      const file = await checkedTrashFile(selected.rootId, dir, selected.trash);
      const expected = await fingerprint(selected.rootId, file);
      if (!expected) throw new Error('The selected file disappeared before deletion.');
      flight = { id, mount, file, fingerprint: expected };
      await claim.update({ checkpoint: { index, inFlight: { ...flight } } });
    }

    const pending = flight;
    const removed = await ctx.sql.begin(async (tx) => {
      const [selected] = await tx<PurgeRow[]>`
        select fd.scan_root_id::text as "rootId", sr.path as root, fd.trash_rel_path as trash, fd.trash_mount as "trashMount"
          from file_deletions fd join scan_roots sr on sr.id = fd.scan_root_id
        where fd.file_id = ${id} and fd.purge_task_id = ${row.id} and fd.state = 'trashed' and sr.writable for update of fd`;
      if (!selected) throw new Error('A reserved Trash entry changed.');
      const { mount, dir } = await checkedTrash(selected.rootId, selected.root);
      if (mount !== pending.mount) throw new Error('The music mount changed during Empty Trash.');
      // null only when the file is really not there (an unlink cut off may have gone through); offline throws
      const actual = await fingerprint(selected.rootId, pending.file);
      if (actual !== null) {
        if (actual !== pending.fingerprint || await checkedTrashFile(selected.rootId, dir, selected.trash) !== pending.file) {
          throw new Error('The selected Trash file was replaced.');
        }
        if ((await claim.current()).cancel_requested) return false;
        await fileGate().run(selected.rootId, { op: 'unlink', path: pending.file });
      }
      await tx`update file_deletions set state = 'purged' where file_id = ${id}`;
      if (!await updateMaintenanceTask(tx, work, { checkpoint: { index: index + 1 }, progress: { done: index + 1, total } })) {
        throw new Error('Empty Trash lost its worker claim');
      }
      await removeEmptyDirs(selected.rootId, selected.root, path.dirname(pending.file));
      return true;
    });
    if (!removed) break;
    index++;

    if (index % 100 === 0) await cleanPurged(ctx, row.library_id);
  }
  await cleanPurged(ctx, row.library_id);
  const cancelled = (await claim.current()).cancel_requested;
  await ctx.sql`update file_deletions set purge_task_id = null where purge_task_id = ${row.id}`;
  return {
    state: cancelled ? 'cancelled' as const : 'done' as const,
    stage: cancelled ? 'Empty Trash cancelled' : 'Trash selection deleted',
    progress: { done: index, total },
    checkpoint: null,
  };
}

export interface FilesTrashJobData {
  /** one library, or every library (the daily run) */
  libraryId?: string;
  /** move: what waits to go in · restore: what waits to come back · empty: Empty trash · sweep: the daily run */
  action?: 'move' | 'restore' | 'empty' | 'sweep';
  maintenance?: MaintenanceWork;
}

/** files.trash: the moves into and out of the trash, Empty trash, and the daily 30-day clean-up. */
export async function filesTrashJob(ctx: WorkerContext, data: FilesTrashJobData): Promise<Record<string, unknown>> {
  const lib = data.libraryId ?? null;
  switch (data.action) {
    case 'move': return moveWaiting(ctx, lib);
    case 'restore': return restoreWaiting(ctx, lib);
    case 'empty': {
      if (!data.maintenance) {
        ctx.logger.warn({ libraryId: lib }, 'Ignored legacy Empty Trash job without a confirmed selection');
        return { skipped: 'No confirmed Trash selection' };
      }
      const work = data.maintenance;
      await runMaintenance(ctx, work, (claim) => purgeSelected(ctx, work, claim));
      return {};
    }
    default: {
      // the daily run also picks up a move or restore whose job was lost (ruling R23);
      // a root that is not online is skipped quietly, its rows left for a run after its return
      const moved = await moveWaiting(ctx, lib, new Date(), { onlineOnly: true });
      const restored = await restoreWaiting(ctx, lib, { onlineOnly: true });
      const expired = await emptyTrash(ctx, lib, TRASH_DAYS, { onlineOnly: true });
      return { moved, restored, expired };
    }
  }
}
