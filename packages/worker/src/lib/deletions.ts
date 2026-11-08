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
 */
import { lstat, mkdir, readdir, rename, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { albumKeyLock, updateMaintenanceTask, type MaintenanceWork } from '@tagave/db';
import { TRASH_DAYS, TRASH_DIR } from '@tagave/shared';
import type { WorkerContext } from './context.js';
import { refreshAlbumCounters } from '../jobs/clusterDir.js';
import { fileStat, insideRoot, mountIdentity } from './fileRecovery.js';
import { runMaintenance, type MaintenanceRun } from './maintenance.js';
import { albumsChanged } from './albumCare.js';

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

export async function exists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

/** The path on disk of a relative path, trying the NFC and NFD spellings (the archive mixes them). */
export async function onDisk(root: string, relPath: string): Promise<string | null> {
  for (const cand of new Set([relPath, relPath.normalize('NFD'), relPath.normalize('NFC')])) {
    const p = path.join(root, cand);
    if (await exists(p)) return p;
  }
  return null;
}

/** The root's trash folder with its .ndignore, made when missing. */
export async function ensureTrashDir(root: string): Promise<string> {
  const dir = path.join(root, TRASH_DIR);
  await mkdir(dir, { recursive: true });
  if (!(await fileStat(dir))?.isDirectory()) throw new Error('The Trash folder is not a directory');
  const ignore = path.join(dir, NDIGNORE);
  if (!(await fileStat(ignore))) {
    await writeFile(ignore, '', { flag: 'wx' }).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'EEXIST') throw err;
    });
  }
  if (!(await fileStat(ignore))?.isFile()) throw new Error('The Trash marker is not a regular file');
  return dir;
}

type Outcome = 'trashed' | 'marked' | 'gone';

/**
 * Moves one file into its root's trash. 'marked' when it cannot (another
 * filesystem, no write access): the row becomes a mark with the reason.
 */
export async function trashOne(root: string, relPath: string, day: string): Promise<{ outcome: Outcome; trashRelPath?: string; trashMount?: string; error?: string }> {
  const src = await onDisk(root, relPath);
  if (!src) return { outcome: 'gone' };
  try {
    const trashMount = await mountIdentity(root);
    const trashDir = await ensureTrashDir(root);
    if ((await stat(src)).dev !== (await stat(trashDir)).dev) return { outcome: 'marked', error: 'On another disk than its music folder' };
    let rel = trashRelPath(relPath, day);
    // the same path trashed twice in a day: the later one gets a numbered day folder
    for (let n = 2; await exists(path.join(root, rel)); n++) rel = trashRelPath(relPath, `${day}-${n}`);
    const dest = path.join(root, rel);
    await insideRoot(root, src);
    await insideRoot(trashDir, dest);
    await mkdir(path.dirname(dest), { recursive: true });
    await rename(src, dest);
    return { outcome: 'trashed', trashRelPath: rel, trashMount };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { outcome: 'gone' };
    return { outcome: 'marked', error: code === 'EXDEV' ? 'On another disk than its music folder' : code === 'EACCES' || code === 'EPERM' || code === 'EROFS' ? 'The music folder is read-only' : (err as Error).message };
  }
}

interface Row { fileId: string; libraryId: string; root: string; relPath: string; trashRelPath: string | null; trashMount: string | null }

async function rowsIn(ctx: Pick<WorkerContext, 'sql'>, libraryId: string | null, state: string, olderThanDays?: number): Promise<Row[]> {
  return (await ctx.sql`
    select fd.file_id::text as "fileId", fd.library_id::text as "libraryId", sr.path as root,
           fd.rel_path as "relPath", fd.trash_rel_path as "trashRelPath", fd.trash_mount as "trashMount"
      from file_deletions fd join scan_roots sr on sr.id = fd.scan_root_id
     where fd.kind = 'trash' and fd.state = ${state}
       and (${libraryId}::uuid is null or fd.library_id = ${libraryId}::uuid)
       and fd.purge_task_id is null
       and (${olderThanDays ?? null}::int is null or fd.trashed_at < now() - make_interval(days => ${olderThanDays ?? 0}))
     order by fd.created_at`) as unknown as Row[];
}

/** Every file waiting to go into the trash ('moving'). */
export async function moveWaiting(ctx: WorkerContext, libraryId: string | null, now = new Date()): Promise<{ trashed: number; marked: number; dropped: number }> {
  const rows = await rowsIn(ctx, libraryId, 'moving');
  const day = trashDay(now);
  let trashed = 0;
  let marked = 0;
  const gone: string[] = [];
  for (const r of rows) {
    const out = await trashOne(r.root, r.relPath, day);
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
  return { trashed, marked, dropped };
}

/** Every file waiting to come back ('restoring'): renamed to where it was, unless that place is taken. */
export async function restoreWaiting(ctx: WorkerContext, libraryId: string | null): Promise<{ restored: number; refused: number; dropped: number }> {
  const rows = await rowsIn(ctx, libraryId, 'restoring');
  let restored = 0;
  let refused = 0;
  const gone: string[] = [];
  const libs = new Set<string>();
  const back: string[] = [];
  for (const r of rows) {
    const src = r.trashRelPath ? await onDisk(r.root, r.trashRelPath) : null;
    if (!src) { gone.push(r.fileId); continue; }
    const dest = path.join(r.root, r.relPath);
    if (await exists(dest)) {
      refused++;
      await ctx.sql`update file_deletions set state = 'trashed', error = 'Another file is in its place' where file_id = ${r.fileId}`;
      continue;
    }
    try {
      await mkdir(path.dirname(dest), { recursive: true });
      await rename(src, dest);
    } catch (err) {
      refused++;
      await ctx.sql`update file_deletions set state = 'trashed', error = ${(err as Error).message} where file_id = ${r.fileId}`;
      continue;
    }
    restored++;
    libs.add(r.libraryId);
    back.push(r.fileId);
    await ctx.sql`delete from file_deletions where file_id = ${r.fileId}`;
    await removeEmptyDirs(r.root, path.dirname(src));
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
  return { restored, refused, dropped };
}

/** Removes empty folders from `dir` up to the trash folder (never the trash folder itself). */
async function removeEmptyDirs(root: string, dir: string): Promise<void> {
  const top = path.join(root, TRASH_DIR);
  for (let d = dir; d.startsWith(top + path.sep); d = path.dirname(d)) {
    try {
      if ((await readdir(d)).length > 0) return;
      await rmdir(d);
    } catch {
      return;
    }
  }
}

async function checkedTrash(root: string): Promise<{ mount: string; dir: string }> {
  const mount = await mountIdentity(root).catch(() => {
    throw new Error('The music folder is unavailable. Check the mount.');
  });
  const dir = path.join(root, TRASH_DIR);
  if (!(await fileStat(dir))?.isDirectory() || !(await fileStat(path.join(dir, NDIGNORE)))?.isFile()) {
    throw new Error('The music folder’s Trash is unavailable. Check the mount.');
  }
  if ((await stat(root)).dev !== (await stat(dir)).dev) throw new Error('Trash is on a different mount.');
  return { mount, dir };
}

async function checkedTrashFile(dir: string, rel: string | null): Promise<string> {
  if (!rel?.startsWith(TRASH_DIR + '/') || rel.split('/').some((segment) => !segment || segment === '..' || segment === '.')) {
    throw new Error('The file has no valid Trash path.');
  }
  const root = path.dirname(dir);
  for (const name of new Set([rel, rel.normalize('NFD'), rel.normalize('NFC')])) {
    const file = path.join(root, name);
    const info = await fileStat(file);
    if (!info) continue;
    await insideRoot(dir, file);
    if (!info.isFile() || info.dev !== (await stat(dir)).dev) throw new Error('The Trash file changed or is on another mount.');
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

/** Scheduled cleanup locks an eligible row against Restore and a manual purge. */
export async function emptyTrash(ctx: WorkerContext, libraryId: string | null, olderThanDays?: number): Promise<{ deleted: number; failed: number }> {
  const rows = await rowsIn(ctx, libraryId, 'trashed', olderThanDays);
  let failed = 0;
  for (const r of rows) {
    try {
      await ctx.sql.begin(async (tx) => {
        const [locked] = await tx`select fd.file_id from file_deletions fd join scan_roots sr on sr.id = fd.scan_root_id
          where fd.file_id = ${r.fileId} and fd.state = 'trashed' and fd.purge_task_id is null
            and fd.trash_rel_path = ${r.trashRelPath} and sr.path = ${r.root} for update of fd skip locked`;
        if (!locked) return;
        const { dir, mount } = await checkedTrash(r.root);
        if (r.trashMount && r.trashMount !== mount) throw new Error('The Trash mount changed.');
        const file = await checkedTrashFile(dir, r.trashRelPath);
        await unlink(file);
        await tx`update file_deletions set state = 'purged' where file_id = ${r.fileId}`;
        await removeEmptyDirs(r.root, path.dirname(file));
      });
    } catch (err) {
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
type PurgeRow = { root: string; trash: string | null; trashMount: string | null };

async function fingerprint(file: string): Promise<string | null> {
  const info = await fileStat(file);
  if (!info) return null;
  if (!info.isFile()) throw new Error('The Trash path is no longer a regular file.');
  return JSON.stringify([info.dev, info.ino, info.size, info.mtimeMs]);
}

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
        select sr.path as root, fd.trash_rel_path as trash, fd.trash_mount as "trashMount" from file_deletions fd join scan_roots sr on sr.id = fd.scan_root_id
        where fd.file_id = ${id} and fd.purge_task_id = ${row.id} and fd.state = 'trashed' and sr.writable`;
      if (!selected) throw new Error('A selected Trash entry or its writable music folder changed.');
      const { mount, dir } = await checkedTrash(selected.root);
      if (selected.trashMount && selected.trashMount !== mount) throw new Error('The Trash mount changed.');
      const file = await checkedTrashFile(dir, selected.trash);
      const expected = await fingerprint(file);
      if (!expected) throw new Error('The selected file disappeared before deletion.');
      flight = { id, mount, file, fingerprint: expected };
      await claim.update({ checkpoint: { index, inFlight: { ...flight } } });
    }

    const pending = flight;
    const removed = await ctx.sql.begin(async (tx) => {
      const [selected] = await tx<PurgeRow[]>`
        select sr.path as root, fd.trash_rel_path as trash, fd.trash_mount as "trashMount" from file_deletions fd join scan_roots sr on sr.id = fd.scan_root_id
        where fd.file_id = ${id} and fd.purge_task_id = ${row.id} and fd.state = 'trashed' and sr.writable for update of fd`;
      if (!selected) throw new Error('A reserved Trash entry changed.');
      const { mount, dir } = await checkedTrash(selected.root);
      if (mount !== pending.mount) throw new Error('The music mount changed during Empty Trash.');
      const actual = await fingerprint(pending.file);
      if (actual !== null) {
        if (actual !== pending.fingerprint || await checkedTrashFile(dir, selected.trash) !== pending.file) {
          throw new Error('The selected Trash file was replaced.');
        }
        if ((await claim.current()).cancel_requested) return false;
        await unlink(pending.file);
      }
      await tx`update file_deletions set state = 'purged' where file_id = ${id}`;
      if (!await updateMaintenanceTask(tx, work, { checkpoint: { index: index + 1 }, progress: { done: index + 1, total } })) {
        throw new Error('Empty Trash lost its worker claim');
      }
      await removeEmptyDirs(selected.root, path.dirname(pending.file));
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
      // the daily run also picks up a move or restore whose job was lost
      const moved = await moveWaiting(ctx, lib);
      const restored = await restoreWaiting(ctx, lib);
      const expired = await emptyTrash(ctx, lib, TRASH_DAYS);
      return { moved, restored, expired };
    }
  }
}
