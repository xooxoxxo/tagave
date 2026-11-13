/**
 * Organize (0081, vault "tagave - Naming Rules and Drop Pool"): the plan
 * that moves an album's files to the paths the naming rules give, from the
 * tags they carry now. files.move runs it like any other move (journal,
 * Undo, the emptied folders into the trash).
 *
 * Used after a tag plan wrote its tags (tags.apply queues one move per album
 * folder, tag_plan_id set) and by Library care › Organize. No tag changes:
 * a tag plan wrote them already.
 */
import { constants as fsConstants } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { albumPaths, currentFieldsFrom, samePath } from '@tagave/core';
import type { MovePlan, MovePlanFile } from '@tagave/shared';
import type { WorkerContext } from '../lib/context.js';
import { exists, onDisk } from '../lib/deletions.js';
import { discDirNumber } from '../lib/helpers.js';
import { albumDirOf, companionFiles, namingRulesFor } from '../lib/naming.js';

interface OrganizeFile {
  id: string; rootId: string; relPath: string; tags: unknown; status: string; deleted: boolean;
  trackId: string | null; origin: string | null; albumId: string | null; title: string | null;
}

const fold = (p: string) => p.normalize('NFC').toLowerCase();

/** The plan for these files (one album folder); throws with the reason when nothing can move. */
export async function organizePlanFor(ctx: WorkerContext, libraryId: string, fileIds: readonly string[]): Promise<{ plan: MovePlan; sourceAlbumId: string | null }> {
  if (fileIds.length === 0) throw new Error('Nothing to move');
  const all = (await ctx.sql`
    select f.id::text as id, f.scan_root_id::text as "rootId", f.rel_path as "relPath",
           jsonb_build_object('common', f.tags_raw->'common') as tags, f.status,
           exists (select 1 from file_deletions fd where fd.file_id = f.id) as deleted,
           lt.id::text as "trackId", lt.origin, lt.local_album_id::text as "albumId", lt.title_guess as title
      from files f
      left join lateral (select * from local_tracks x where x.audio_file_id = f.id order by x.origin = 'cue', x.id limit 1) lt on true
     where f.id = any(${fileIds as string[]}::uuid[]) and f.library_id = ${libraryId}
     order by f.rel_path`) as unknown as OrganizeFile[];
  // a cue image is one file of many tracks: its name is the image's, not a track's
  const files = all.filter((f) => f.status === 'present' && !f.deleted && f.origin !== 'cue');
  if (files.length === 0) throw new Error('The songs are gone');
  const rootCount = new Map<string, number>();
  for (const f of files) rootCount.set(f.rootId, (rootCount.get(f.rootId) ?? 0) + 1);
  const rootId = [...rootCount.entries()].sort((a, b) => b[1] - a[1])[0]![0];
  const inRoot = files.filter((f) => f.rootId === rootId);
  const [root] = (await ctx.sql`select path from scan_roots where id = ${rootId}`) as unknown as Array<{ path: string }>;
  if (!root) throw new Error('The music folder is gone');

  const albumCount = new Map<string, number>();
  for (const f of inRoot) if (f.albumId) albumCount.set(f.albumId, (albumCount.get(f.albumId) ?? 0) + 1);
  const sourceAlbumId = [...albumCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const [album] = sourceAlbumId ? (await ctx.sql`
    select la.title_guess as title, la.artist_guess as artist, la.year_guess as year, la.release_id::text as "releaseId",
           r.mbid::text as mbid, coalesce(rg.secondary_types, '{}') as types, coalesce(la.track_count, 0)::int as tracks
      from local_albums la
      left join releases r on r.id = la.release_id
      left join release_groups rg on rg.id = la.release_group_id
     where la.id = ${sourceAlbumId}`) as unknown as Array<{
    title: string | null; artist: string | null; year: number | null; releaseId: string | null; mbid: string | null; types: string[]; tracks: number;
  }> : [];

  const { rules } = await namingRulesFor(ctx, libraryId);
  const soundtrack = (album?.types ?? []).some((t) => t.toLowerCase() === 'soundtrack');
  const planned = albumPaths(rules, inRoot.map((f) => ({ relPath: f.relPath, fields: currentFieldsFrom(f.tags) })), { soundtrack });
  if (planned.leftAlone) throw new Error('In a Leave alone folder');

  const toDir = planned.dir;
  const albumDir = albumDirOf(inRoot.map((f) => f.relPath), (b) => discDirNumber(b) !== null);
  const moving = new Set(inRoot.map((f) => f.relPath));
  const extras = (await companionFiles(root.path, albumDir, moving, toDir))
    // a target folder inside the old one: what is already there stays where it is
    .filter((e) => !(toDir.startsWith(`${albumDir}/`) && (e.fromPath === toDir || e.fromPath.startsWith(`${toDir}/`))));
  const target = new Map(planned.files.map((p) => [p.relPath, p.toPath]));

  const planFiles: MovePlanFile[] = [];
  const names = new Map<string, number>();
  for (const p of planned.files) names.set(fold(p.toPath), (names.get(fold(p.toPath)) ?? 0) + 1);
  for (const e of extras) names.set(fold(e.toPath), (names.get(fold(e.toPath)) ?? 0) + 1);
  const ours = new Set([...inRoot.map((f) => fold(f.relPath)), ...extras.map((e) => fold(e.fromPath))]);
  for (const f of inRoot) {
    const toPath = target.get(f.relPath)!;
    const same = samePath(toPath, f.relPath);
    // taken: two files given one name, or a file on disk that is not one of those moving
    const clash = !same && (names.get(fold(toPath))! > 1 || (!ours.has(fold(toPath)) && !!(await onDisk(root.path, toPath))));
    planFiles.push({
      fileId: f.id, localTrackId: f.trackId, title: f.title ?? path.posix.basename(f.relPath),
      fromPath: f.relPath, toPath, target: null, confidence: null, diff: [], stays: null, clash,
    });
  }
  const plan: MovePlan = {
    scanRootId: rootId,
    toDir,
    newFolder: !(await onDisk(root.path, toDir)),
    naming: rules.file,
    release: {
      id: album?.releaseId ?? '', mbid: album?.mbid ?? null, title: album?.title ?? path.posix.basename(albumDir || toDir),
      artist: album?.artist ?? '', year: album?.year ?? null, tracks: album?.tracks ?? inRoot.length,
    },
    files: planFiles,
    extras: extras.filter((e) => !samePath(e.fromPath, e.toPath)),
  };
  return { plan, sourceAlbumId };
}

export interface PreviewFile {
  audioFileId: string;
  scanRootId: string;
  relPath: string;
  /** the file's tags after the plan (canonical fields) */
  fields: Record<string, unknown>;
}

export interface PreviewPath {
  toPath: string;
  state: 'clash' | 'unwritable' | null;
}

const albumKey = (f: Record<string, unknown>) => {
  const s = (v: unknown) => String(Array.isArray(v) ? v[0] ?? '' : v ?? '').normalize('NFC').toLowerCase().trim();
  return `${s(f['albumartist']) || s(f['artist'])}\n${s(f['album'])}`;
};

/** Writable: the folder, or the nearest one of its parents that exists, takes new entries. */
async function canWrite(root: string, dir: string): Promise<boolean> {
  for (let d = dir; ; d = path.posix.dirname(d)) {
    const abs = path.join(root, d === '.' ? '' : d);
    if (await exists(abs)) {
      try { await access(abs, fsConstants.W_OK); return true; } catch { return false; }
    }
    if (d === '.' || d === '') return false;
  }
}

/**
 * A tag plan's preview: where the naming rules put each file once its tags
 * are written. Files group into albums by folder and album tags (one album,
 * one folder); a file whose path stays is left out. A cue image keeps its
 * name; a Leave alone folder keeps its files.
 */
export async function previewPaths(ctx: WorkerContext, libraryId: string, files: readonly PreviewFile[]): Promise<Map<string, PreviewPath>> {
  const out = new Map<string, PreviewPath>();
  if (files.length === 0) return out;
  const { rules } = await namingRulesFor(ctx, libraryId);
  const ids = files.map((f) => f.audioFileId);
  const cue = new Set(((await ctx.sql`
    select distinct audio_file_id::text as id from local_tracks where audio_file_id = any(${ids}::uuid[]) and origin = 'cue'`) as unknown as Array<{ id: string }>).map((r) => r.id));
  const soundtrack = new Set(((await ctx.sql`
    select distinct lt.audio_file_id::text as id from local_tracks lt
      join local_albums la on la.id = lt.local_album_id join release_groups rg on rg.id = la.release_group_id
     where lt.audio_file_id = any(${ids}::uuid[]) and 'Soundtrack' = any(rg.secondary_types)`) as unknown as Array<{ id: string }>).map((r) => r.id));
  const roots = new Map(((await ctx.sql`select id::text as id, path from scan_roots where library_id = ${libraryId}`) as unknown as Array<{ id: string; path: string }>).map((r) => [r.id, r.path]));
  const groups = new Map<string, PreviewFile[]>();
  for (const f of files) {
    if (cue.has(f.audioFileId)) continue;
    const k = `${f.scanRootId}\n${albumDirOf([f.relPath], (b) => discDirNumber(b) !== null)}\n${albumKey(f.fields)}`;
    const g = groups.get(k);
    if (g) g.push(f);
    else groups.set(k, [f]);
  }
  for (const g of groups.values()) {
    const root = roots.get(g[0]!.scanRootId);
    if (!root) continue;
    const planned = albumPaths(rules, g.map((f) => ({ relPath: f.relPath, fields: f.fields as Record<string, string | string[] | null> })), {
      soundtrack: g.some((f) => soundtrack.has(f.audioFileId)),
    });
    if (planned.leftAlone) continue;
    const ours = new Set(g.map((f) => fold(f.relPath)));
    const names = new Map<string, number>();
    for (const p of planned.files) names.set(fold(p.toPath), (names.get(fold(p.toPath)) ?? 0) + 1);
    const writable = await canWrite(root, planned.dir);
    for (const [i, p] of planned.files.entries()) {
      if (samePath(p.toPath, p.relPath)) continue;
      const clash = names.get(fold(p.toPath))! > 1 || (!ours.has(fold(p.toPath)) && !!(await onDisk(root, p.toPath)));
      out.set(g[i]!.audioFileId, { toPath: p.toPath, state: clash ? 'clash' : writable ? null : 'unwritable' });
    }
  }
  return out;
}

/**
 * After a tag plan wrote its tags: one organize move per album of the files
 * whose path the preview said changes (by their old album folder and their
 * new one). An album with a file whose path is blocked (taken, unwritable)
 * is left out whole: its tags applied, its files stay. Returns the moves
 * queued.
 */
export async function queueOrganizeAfterPlan(ctx: Pick<WorkerContext, 'sql' | 'boss' | 'logger'>, planId: string): Promise<number> {
  const rows = (await ctx.sql`
    select i.audio_file_id::text as "fileId", f.scan_root_id::text as "rootId", f.rel_path as "relPath",
           i.path_before as "pathBefore", i.path_after as "pathAfter", i.path_state as "pathState", i.status,
           p.library_id::text as "libraryId", p.created_by::text as "createdBy"
      from tag_plan_items i join tag_plans p on p.id = i.tag_plan_id join files f on f.id = i.audio_file_id
     where i.tag_plan_id = ${planId} and i.path_after is not null`) as unknown as Array<{
    fileId: string; rootId: string; relPath: string; pathBefore: string | null; pathAfter: string; pathState: string | null;
    status: string; libraryId: string; createdBy: string | null;
  }>;
  if (rows.length === 0) return 0;
  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    const k = `${r.rootId}\n${albumDirOf([r.pathBefore ?? r.relPath], (b) => discDirNumber(b) !== null)}\n${path.posix.dirname(r.pathAfter)}`;
    const g = groups.get(k);
    if (g) g.push(r);
    else groups.set(k, [r]);
  }
  const ready = [...groups.values()]
    // every file written (or with no tag change) and still where the preview saw it; none blocked
    .filter((g) => g.every((r) => r.status === 'applied' && !r.pathState && (r.pathBefore === null || r.pathBefore === r.relPath)))
    .map((g) => g.map((r) => r.fileId));
  return queueOrganizeMoves(ctx, rows[0]!.libraryId, ready, { tagPlanId: planId, createdBy: rows[0]!.createdBy });
}

/** One organize move per group of files (one album each). Returns the moves queued. */
export async function queueOrganizeMoves(
  ctx: Pick<WorkerContext, 'sql' | 'boss' | 'logger'>,
  libraryId: string,
  groups: ReadonlyArray<readonly string[]>,
  opts: { tagPlanId?: string | null; createdBy?: string | null } = {},
): Promise<number> {
  let queued = 0;
  for (const ids of groups) {
    if (ids.length === 0) continue;
    const [row] = (await ctx.sql`
      insert into album_moves (library_id, kind, tag_plan_id, source_track_ids, state, query, created_by)
      values (${libraryId}, 'organize', ${opts.tagPlanId ?? null}::uuid, '{}'::uuid[], 'planning',
              ${JSON.stringify({ fileIds: ids })}::jsonb, ${opts.createdBy ?? null}::uuid)
      returning id::text as id`) as unknown as Array<{ id: string }>;
    try {
      await ctx.boss.send('files.move', { moveId: row!.id, action: 'plan' }, { singletonKey: `files.move:${row!.id}:plan` });
      queued++;
    } catch (err) {
      ctx.logger.warn({ moveId: row!.id, err: (err as Error).message }, 'organize: could not queue the move');
    }
  }
  return queued;
}
