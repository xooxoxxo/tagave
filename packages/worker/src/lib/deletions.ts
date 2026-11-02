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
import { albumKeyLock } from '@tagave/db';
import { TRASH_DAYS, TRASH_DIR } from '@tagave/shared';
import type { WorkerContext } from './context.js';
import { refreshAlbumCounters } from '../jobs/clusterDir.js';

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
  return { dropped, albumsRemoved };
}

/** `YYYY-MM-DD` of the day, UTC: the trash folder's day folder. */
export const trashDay = (d: Date): string => d.toISOString().slice(0, 10);

/** The relative path a file moves to: `.tagave-trash/<day>/<its relative path>`. */
export function trashRelPath(relPath: string, day: string): string {
  return `${TRASH_DIR}/${day}/${relPath}`;
}

async function exists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

/** The path on disk of a relative path, trying the NFC and NFD spellings (the archive mixes them). */
async function onDisk(root: string, relPath: string): Promise<string | null> {
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
  const ignore = path.join(dir, NDIGNORE);
  if (!(await exists(ignore))) await writeFile(ignore, '');
  return dir;
}

type Outcome = 'trashed' | 'marked' | 'gone';

/**
 * Moves one file into its root's trash. 'marked' when it cannot (another
 * filesystem, no write access): the row becomes a mark with the reason.
 */
export async function trashOne(root: string, relPath: string, day: string): Promise<{ outcome: Outcome; trashRelPath?: string; error?: string }> {
  const src = await onDisk(root, relPath);
  if (!src) return { outcome: 'gone' };
  try {
    const trashDir = await ensureTrashDir(root);
    if ((await stat(src)).dev !== (await stat(trashDir)).dev) return { outcome: 'marked', error: 'On another disk than its music folder' };
    let rel = trashRelPath(relPath, day);
    // the same path trashed twice in a day: the later one gets a numbered day folder
    for (let n = 2; await exists(path.join(root, rel)); n++) rel = trashRelPath(relPath, `${day}-${n}`);
    const dest = path.join(root, rel);
    await mkdir(path.dirname(dest), { recursive: true });
    await rename(src, dest);
    return { outcome: 'trashed', trashRelPath: rel };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { outcome: 'gone' };
    return { outcome: 'marked', error: code === 'EXDEV' ? 'On another disk than its music folder' : code === 'EACCES' || code === 'EPERM' || code === 'EROFS' ? 'The music folder is read-only' : (err as Error).message };
  }
}

interface Row { fileId: string; libraryId: string; root: string; relPath: string; trashRelPath: string | null }

async function rowsIn(ctx: Pick<WorkerContext, 'sql'>, libraryId: string | null, state: string, olderThanDays?: number): Promise<Row[]> {
  return (await ctx.sql`
    select fd.file_id::text as "fileId", fd.library_id::text as "libraryId", sr.path as root,
           fd.rel_path as "relPath", fd.trash_rel_path as "trashRelPath"
      from file_deletions fd join scan_roots sr on sr.id = fd.scan_root_id
     where fd.kind = 'trash' and fd.state = ${state}
       and (${libraryId}::uuid is null or fd.library_id = ${libraryId}::uuid)
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
      await ctx.sql`update file_deletions set state = 'trashed', trash_rel_path = ${out.trashRelPath!}, trashed_at = now(), error = null
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
    await ctx.sql`delete from file_deletions where file_id = ${r.fileId}`;
    await removeEmptyDirs(r.root, path.dirname(src));
  }
  for (const l of libs) await markLibraryDirty(ctx, l);
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

/** Deletes what is in the trash for real: everything (Empty trash) or what is older than `olderThanDays`. */
export async function emptyTrash(ctx: WorkerContext, libraryId: string | null, olderThanDays?: number): Promise<{ deleted: number; failed: number }> {
  const rows = await rowsIn(ctx, libraryId, 'trashed', olderThanDays);
  const done: string[] = [];
  let failed = 0;
  for (const r of rows) {
    const p = r.trashRelPath ? await onDisk(r.root, r.trashRelPath) : null;
    try {
      if (p) {
        await unlink(p);
        await removeEmptyDirs(r.root, path.dirname(p));
      }
      done.push(r.fileId);
    } catch (err) {
      failed++;
      await ctx.sql`update file_deletions set error = ${(err as Error).message} where file_id = ${r.fileId}`;
    }
  }
  const { dropped } = await dropDeletedFiles(ctx, done);
  return { deleted: dropped, failed };
}

export interface FilesTrashJobData {
  /** one library, or every library (the daily run) */
  libraryId?: string;
  /** move: what waits to go in · restore: what waits to come back · empty: Empty trash · sweep: the daily run */
  action?: 'move' | 'restore' | 'empty' | 'sweep';
}

/** files.trash: the moves into and out of the trash, Empty trash, and the daily 30-day clean-up. */
export async function filesTrashJob(ctx: WorkerContext, data: FilesTrashJobData): Promise<Record<string, unknown>> {
  const lib = data.libraryId ?? null;
  switch (data.action) {
    case 'move': return moveWaiting(ctx, lib);
    case 'restore': return restoreWaiting(ctx, lib);
    case 'empty': return emptyTrash(ctx, lib);
    default: {
      // the daily run also picks up a move or restore whose job was lost
      const moved = await moveWaiting(ctx, lib);
      const restored = await restoreWaiting(ctx, lib);
      const expired = await emptyTrash(ctx, lib, TRASH_DAYS);
      return { moved, restored, expired };
    }
  }
}
