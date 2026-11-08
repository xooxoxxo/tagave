/**
 * Deleting songs and albums (0073 file_deletions; vault "tagave - Deleting
 * Songs and Albums"). The API writes the rows and asks the file worker for
 * the moves; it never touches a music file itself.
 *
 * Mark: the row alone takes the file out of the library; the owner deletes it
 * on the server with deleteCommand(). Trash: the row is 'moving' until the
 * worker (files.trash) renames the file into the root's trash folder. A root
 * that is not writable (the setting or the worker's check) marks instead.
 */
import type postgres from 'postgres';
import {
  TRASH_DAYS, type CreateDeletionsResult, type DeleteMode, type DeletingView, type DeletionGroup,
} from '@tagave/shared';
import { latestMaintenanceTask, saveMaintenanceTask } from '@tagave/db';
import { ApiError } from '../middleware/errorHandler.js';
import { liveMaintenanceQueues, maintenanceView } from './maintenance.js';
import { getBoss } from '../boss.js';

type Sql = postgres.Sql;

/** The library's mode (Settings › Library › Deleting); Mark until the owner picks Trash. */
export function deleteModeOf(settings: unknown): DeleteMode {
  const s = (settings && typeof settings === 'object' ? settings : {}) as Record<string, unknown>;
  return s['deleteMode'] === 'trash' ? 'trash' : 'mark';
}

/** Roots the worker may move files in: enabled, writable by the owner's setting, and the worker's write check passed. */
export async function trashRootIds(sql: Sql, libraryId: string): Promise<Set<string>> {
  const rows = await sql<Array<{ id: string }>>`
    select id::text as id from scan_roots
     where library_id = ${libraryId} and enabled and writable and probe_writable is true`;
  return new Set(rows.map((r) => r.id));
}

export async function librarySettings(sql: Sql, libraryId: string): Promise<Record<string, unknown> | null> {
  const [row] = await sql<Array<{ settings: unknown }>>`select settings from libraries where id = ${libraryId}`;
  if (!row) return null;
  return (row.settings && typeof row.settings === 'object' ? row.settings : {}) as Record<string, unknown>;
}

/** Ask the file worker to do what is waiting (moves, restores, emptying). Best effort: its daily run catches up. */
export async function sendTrashJob(libraryId: string, action: 'move' | 'restore'): Promise<void> {
  const boss = await getBoss();
  await boss.createQueue('files.trash');
  await boss.send('files.trash', { libraryId, action }, { singletonKey: `files.trash:${libraryId}:${action}` });
}

/**
 * Delete these tracks and albums in the library's mode. Every file of an
 * album; a track is its file (a song inside a CUE image takes the image with
 * it). Files already deleted stay as they are.
 */
export async function createDeletions(sql: Sql, input: {
  libraryId: string; userId: string; mode: DeleteMode; trackIds: string[]; albumIds: string[];
}): Promise<CreateDeletionsResult> {
  const files = await sql<Array<{ id: string; scanRootId: string; relPath: string }>>`
    select distinct af.id::text as id, af.scan_root_id::text as "scanRootId", af.rel_path as "relPath"
      from local_tracks lt join files af on af.id = lt.audio_file_id
     where af.library_id = ${input.libraryId}
       and af.status in ('present', 'error')
       and (lt.id = any(${input.trackIds}::uuid[]) or lt.local_album_id = any(${input.albumIds}::uuid[]))`;
  if (files.length === 0) return { marked: 0, trashed: 0 };
  const writable = input.mode === 'trash' ? await trashRootIds(sql, input.libraryId) : new Set<string>();
  const kinds = files.map((f) => (writable.has(f.scanRootId) ? 'trash' : 'mark'));
  const rows = await sql<Array<{ kind: string }>>`
    insert into file_deletions (file_id, library_id, scan_root_id, kind, state, rel_path, created_by)
    select u.id, ${input.libraryId}::uuid, u.root, u.kind, case when u.kind = 'mark' then 'marked' else 'moving' end, u.rel_path, ${input.userId}::uuid
      from unnest(${files.map((f) => f.id)}::uuid[], ${files.map((f) => f.scanRootId)}::uuid[], ${files.map((f) => f.relPath)}::text[], ${kinds}::text[])
           as u(id, root, rel_path, kind)
    on conflict (file_id) do nothing
    returning kind`;
  const trashed = rows.filter((r) => r.kind === 'trash').length;
  if (trashed > 0) await sendTrashJob(input.libraryId, 'move');
  return { marked: rows.length - trashed, trashed };
}

/** Unmark: the files come back with everything they had. */
export async function unmarkFiles(sql: Sql, libraryId: string, fileIds: string[]): Promise<number> {
  const out = await sql`delete from file_deletions where library_id = ${libraryId} and kind = 'mark' and file_id = any(${fileIds}::uuid[]) returning file_id`;
  return out.length;
}

/** Restore: the worker renames them back (and refuses when the old place is taken). */
export async function restoreFiles(sql: Sql, libraryId: string, fileIds: string[]): Promise<number> {
  const out = await sql`
    update file_deletions set state = 'restoring', error = null
     where library_id = ${libraryId} and kind = 'trash' and state = 'trashed' and purge_task_id is null and file_id = any(${fileIds}::uuid[])
    returning file_id`;
  if (out.length > 0) await sendTrashJob(libraryId, 'restore');
  return out.length;
}

/** One argument for a POSIX shell: single quotes, a quote inside as '\''. */
export function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/**
 * The command that deletes exactly these files on the computer that holds the
 * music: one line per root, `cd` into the root as that computer sees it (the
 * worker's host path, else the root's own path), then `rm -f --` with every
 * relative path quoted. Nothing to edit; a file already gone is no error.
 */
export function deleteCommand(rows: ReadonlyArray<{ root: string; relPath: string }>): string | null {
  if (rows.length === 0) return null;
  const byRoot = new Map<string, string[]>();
  for (const r of rows) {
    const list = byRoot.get(r.root) ?? [];
    list.push(r.relPath);
    byRoot.set(r.root, list);
  }
  return [...byRoot].map(([root, paths]) => `cd ${shellQuote(root)} && rm -f -- ${[...paths].sort().map(shellQuote).join(' ')}`).join('\n');
}

interface DeletionRow {
  fileId: string; kind: 'mark' | 'trash'; state: DeletionGroup['state']; relPath: string; error: string | null;
  createdAt: Date | string; root: string; albumId: string | null; albumTitle: string | null; albumArtist: string | null;
  trackTitle: string | null; trackArtist: string | null; albumFiles: number;
}

/** The shared client hands timestamps back as strings (drizzle swaps its parsers); tests pass Dates. */
const iso = (d: Date | string): string => new Date(d).toISOString();

/** Rows to page groups: one per album (its deleted files together), one per song without an album. */
export function groupDeletions(rows: readonly DeletionRow[]): DeletionGroup[] {
  const groups = new Map<string, DeletionGroup & { rank: number }>();
  for (const r of rows) {
    const key = r.albumId ?? r.fileId;
    let g = groups.get(key);
    if (!g) {
      g = {
        key, albumId: r.albumId, title: r.albumTitle ?? r.trackTitle ?? r.relPath.split('/').pop() ?? r.relPath,
        artist: r.albumArtist ?? r.trackArtist, fileIds: [], trackTitle: r.trackTitle, wholeAlbum: false,
        createdAt: iso(r.createdAt), state: r.state, error: null, rank: 0,
      };
      groups.set(key, g);
    }
    g.fileIds.push(r.fileId);
    if (iso(r.createdAt) > g.createdAt) g.createdAt = iso(r.createdAt);
    if (!g.error && r.error) g.error = r.error;
    // a row on its way in or out speaks for the group
    const rank = r.state === 'moving' || r.state === 'restoring' ? 1 : 0;
    if (rank > g.rank) { g.state = r.state; g.rank = rank; }
    g.wholeAlbum = !!r.albumId && g.fileIds.length >= r.albumFiles;
    g.trackTitle = g.fileIds.length === 1 && !g.wholeAlbum ? r.trackTitle : null;
  }
  return [...groups.values()]
    .map(({ rank: _rank, ...g }) => g)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.title.localeCompare(b.title));
}

/** Reserve the confirmed selection in the same transaction as its task. */
export async function requestEmptyTrash(sql: Sql, libraryId: string, fileIds: string[]) {
  const selection = [...new Set(fileIds)].sort();
  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtextextended(${`tagave:empty-trash:${libraryId}`}, 0))`;
    const existing = await latestMaintenanceTask(tx, libraryId, 'empty-trash', 'trash');
    if (existing && !['done', 'cancelled'].includes(existing.state)) {
      throw new ApiError(409, 'Conflict', 'An Empty Trash task is already open.');
    }
    const task = await saveMaintenanceTask(tx, {
      libraryId, kind: 'empty-trash', scope: 'trash', queue: 'files.trash',
      stage: 'Empty Trash queued', input: { libraryId, action: 'empty', fileIds: selection },
    });
    const locked = await tx`
      select file_id from file_deletions where library_id = ${libraryId}
        and file_id = any(${selection}::uuid[]) and kind = 'trash' and state = 'trashed'
        and trash_rel_path is not null and purge_task_id is null order by file_id for update
    `;
    if (locked.length !== selection.length) {
      throw new ApiError(409, 'Conflict', 'Trash changed. Review the remaining files and confirm again.');
    }
    await tx`update file_deletions set purge_task_id = ${task.id} where file_id = any(${selection}::uuid[])`;
    return task;
  });
}

/** Library care › Deleting. */
export async function deletingView(sql: Sql, libraryId: string, settings: Record<string, unknown>): Promise<DeletingView> {
  const rows = await sql<DeletionRow[]>`
    select fd.file_id::text as "fileId", fd.kind, fd.state, fd.rel_path as "relPath", fd.error, fd.created_at as "createdAt",
           coalesce(sr.host_path, sr.path) as root,
           lt.local_album_id::text as "albumId", la.title_guess as "albumTitle", la.artist_guess as "albumArtist",
           lt.title_guess as "trackTitle", lt.artist_guess as "trackArtist",
           coalesce((select count(distinct x.audio_file_id) from local_tracks x where x.local_album_id = lt.local_album_id), 0)::int as "albumFiles"
      from file_deletions fd
      join scan_roots sr on sr.id = fd.scan_root_id
      left join lateral (
        select t.local_album_id, t.title_guess, t.artist_guess from local_tracks t
         where t.audio_file_id = fd.file_id order by t.cue_start_ms nulls first limit 1) lt on true
      left join local_albums la on la.id = lt.local_album_id
     where fd.library_id = ${libraryId} and fd.state not in ('purged', 'holding')
     order by fd.created_at desc`;
  const task = await latestMaintenanceTask(sql, libraryId, 'empty-trash', 'trash');
  const active = task && !['done', 'cancelled'].includes(task.state);
  const selected = new Set(active ? task.input.fileIds as string[] : []);
  const marked = rows.filter((r) => r.kind === 'mark');
  return {
    mode: deleteModeOf(settings),
    trashAvailable: (await trashRootIds(sql, libraryId)).size > 0,
    marked: groupDeletions(marked),
    trash: [
      ...groupDeletions(rows.filter((r) => r.kind === 'trash' && selected.has(r.fileId)))
        .map((group) => ({ ...group, key: `purge:${group.key}` })),
      ...groupDeletions(rows.filter((r) => r.kind === 'trash' && !selected.has(r.fileId))),
    ],
    emptyFileIds: rows.filter((row) => row.kind === 'trash' && row.state === 'trashed' && !selected.has(row.fileId)).map((row) => row.fileId),
    command: deleteCommand(marked.map((r) => ({ root: r.root, relPath: r.relPath }))),
    trashDays: TRASH_DAYS,
    ...(task ? { emptyTask: {
      task: maintenanceView(task, await liveMaintenanceQueues()),
      fileIds: active ? task.input.fileIds as string[] : [],
    } } : {}),
  };
}
