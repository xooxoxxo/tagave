/**
 * Drop pool import (0081, vault "tagave - Naming Rules and Drop Pool"): the
 * plan that takes a dropped album out of the pool into the library. Each
 * file pairs with a track of the release (the album's own track linking),
 * gets the canonical preset's tag changes, and goes to the path the naming
 * rules give from its tags after them; the folder's covers, cue sheets and
 * logs go with it. files.move writes the tags in the pool, moves, scans the
 * new folder and matches the album it forms to the release.
 *
 * Already in library: Replace moves the library's copy into the trash first
 * (Library care › Deleting can restore it); Keep both puts the import in a
 * folder of its own beside it ("… (2)").
 */
import path from 'node:path';
import { parseFile } from 'music-metadata';
import { albumPaths, currentFieldsFrom, samePath } from '@tagave/core';
import { tagSnapshotOf } from '@tagave/core/files';
import {
  CanonicalField, moveConfidence,
  type MovePlan, type MovePlanFile, type PoolFile, type TagDiffEntry, type TagPolicies,
} from '@tagave/shared';
import type { WorkerContext } from '../lib/context.js';
import { dropDeletedFiles, moveWaiting, onDisk } from '../lib/deletions.js';
import { discDirNumber } from '../lib/helpers.js';
import { albumDirOf, companionFiles, dropPoolOf, isAudioName, namingRulesFor } from '../lib/naming.js';
import { resolveForTarget } from '../lib/resolvedMetadata.js';
import { planTrackLinks } from '../lib/trackLinks.js';
import { decideField, fieldPolicyFor } from './tagsPreview.js';
import { mbRelease, persistFetched } from './identifyAlbum.js';
import { getProviders, libraryProviderSettings } from '../lib/providers.js';

/** The canonical preset a pool import writes with (as Move to album): ids and album fields overwritten, titles and genres filled. */
const IMPORT_POLICY: TagPolicies = { preset: 'canonical_ids_and_fill', id3Version: '2.4', multiValueSeparator: '; ' };

interface ImportRow {
  id: string; libraryId: string;
  query: { poolItemId?: string; releaseId?: string; releaseMbid?: string; existing?: 'replace' | 'keepBoth' } | null;
}

interface PoolItemRow {
  id: string; rootId: string; dirPath: string; files: PoolFile[] | null; existingAlbumId: string | null;
}

function creditName(raw: unknown): string {
  if (!Array.isArray(raw)) return '';
  return raw.map((c: unknown) => {
    if (typeof c === 'string') return c;
    const o = (c ?? {}) as { name?: unknown; joinPhrase?: unknown };
    return `${typeof o.name === 'string' ? o.name : ''}${typeof o.joinPhrase === 'string' ? o.joinPhrase : ''}`;
  }).join('').trim();
}

const yearOf = (d: unknown): number | null => {
  const s = d instanceof Date ? d.toISOString() : typeof d === 'string' ? d : '';
  const y = Number(s.slice(0, 4));
  return Number.isInteger(y) && y > 0 ? y : null;
};

const fold = (p: string) => p.normalize('NFC').toLowerCase();

export async function poolItemOf(ctx: Pick<WorkerContext, 'sql'>, itemId: string): Promise<PoolItemRow | null> {
  const [r] = (await ctx.sql`
    select id::text as id, scan_root_id::text as "rootId", dir_path as "dirPath", files, existing_album_id::text as "existingAlbumId"
      from pool_items where id = ${itemId}`) as unknown as PoolItemRow[];
  return r ?? null;
}

/** A release the owner picked by its MusicBrainz id: the stored one, or fetched (identify's cache and pace). */
async function storedRelease(ctx: WorkerContext, libraryId: string, mbid: string): Promise<string> {
  const [r] = (await ctx.sql`
    select r.id::text as id from releases r
     where r.mbid = ${mbid} and exists (select 1 from canonical_tracks c where c.release_id = r.id)`) as unknown as Array<{ id: string }>;
  if (r) return r.id;
  const providers = getProviders(await libraryProviderSettings(ctx, libraryId));
  return (await persistFetched(ctx, await mbRelease(ctx, providers, mbid))).releaseId;
}

/** The library's album of this release's group, with a song still there (not deleted). */
async function heldAlbum(ctx: Pick<WorkerContext, 'sql'>, libraryId: string, releaseId: string): Promise<string | null> {
  const [held] = (await ctx.sql`
    select la.id::text as id from local_albums la join releases r on r.id = ${releaseId}
     where la.library_id = ${libraryId} and la.release_group_id = r.release_group_id
       and exists (select 1 from local_tracks lt join files f on f.id = lt.audio_file_id
                    where lt.local_album_id = la.id and f.status = 'present'
                      and not exists (select 1 from file_deletions fd where fd.file_id = f.id))
     order by la.state = 'matched' desc, la.track_count desc nulls last limit 1`) as unknown as Array<{ id: string }>;
  return held?.id ?? null;
}

/** The library's copy into the trash (Replace): its files become trash deletions, moved now. */
async function trashExisting(ctx: WorkerContext, libraryId: string, albumId: string): Promise<number> {
  const rows = await ctx.sql`
    insert into file_deletions (file_id, library_id, scan_root_id, kind, state, rel_path)
    select distinct f.id, f.library_id, f.scan_root_id, 'trash', 'moving', f.rel_path
      from local_tracks lt join files f on f.id = lt.audio_file_id
     where lt.local_album_id = ${albumId} and f.library_id = ${libraryId} and f.status = 'present'
    on conflict (file_id) do nothing
    returning file_id`;
  if (rows.length) await moveWaiting(ctx, libraryId);
  return rows.length;
}

/** The plan ('planning'): pairs, tag changes and paths. Throws with the reason when the import cannot go. */
export async function importPlanFor(ctx: WorkerContext, row: ImportRow): Promise<{ plan: MovePlan; existingAlbumId: string | null }> {
  const itemId = row.query?.poolItemId;
  if (!itemId) throw new Error('No album chosen');
  const releaseId = row.query?.releaseId ?? (row.query?.releaseMbid ? await storedRelease(ctx, row.libraryId, row.query.releaseMbid) : null);
  if (!releaseId) throw new Error('No album chosen');
  const item = await poolItemOf(ctx, itemId);
  if (!item) throw new Error('The dropped folder is gone');
  const [root] = (await ctx.sql`select path from scan_roots where id = ${item.rootId}`) as unknown as Array<{ path: string }>;
  if (!root) throw new Error('The music folder is gone');
  const pool = await dropPoolOf(ctx, row.libraryId);

  const [rel] = (await ctx.sql`
    select r.id::text as id, r.mbid::text as mbid, r.title, r.date, rg.first_release_date as "firstDate", rg.artist_credit as credit,
           coalesce(rg.secondary_types, '{}') as types
      from releases r join release_groups rg on rg.id = r.release_group_id where r.id = ${releaseId}`) as unknown as Array<{
    id: string; mbid: string | null; title: string; date: unknown; firstDate: unknown; credit: unknown; types: string[];
  }>;
  if (!rel) throw new Error('The release is gone');
  const canon = (await ctx.sql`
    select id::text as id, medium_no as "mediumNo", position, title, artist_credit as "artistCredit", length_ms as "lengthMs",
           recording_mbid as "recordingMbid", track_mbid as "trackMbid"
      from canonical_tracks
     where release_id = ${releaseId} and not coalesce(is_data_track, false) and not coalesce(is_video, false)
     order by coalesce(medium_no, 1), position`) as unknown as Array<{
    id: string; mediumNo: number | null; position: number | null; title: string; artistCredit: unknown; lengthMs: number | null;
    recordingMbid: string | null; trackMbid: string | null;
  }>;
  if (canon.length === 0) throw new Error('The release has no tracklist');
  const albumArtist = creditName(rel.credit) || 'Unknown artist';

  // the files as they are now: each read again (a tag of the drop may have changed since it was identified)
  const audio = (item.files ?? []).map((f) => f.relPath).filter((p) => isAudioName(path.posix.basename(p)));
  const read: Array<{ relPath: string; abs: string; fields: ReturnType<typeof currentFieldsFrom>; durationMs: number | null }> = [];
  for (const relPath of audio) {
    const abs = await onDisk(root.path, relPath);
    if (!abs) continue;
    const meta = await parseFile(abs, { duration: true });
    read.push({ relPath, abs, fields: currentFieldsFrom(tagSnapshotOf(meta)), durationMs: meta.format.duration ? Math.round(meta.format.duration * 1000) : null });
  }
  if (read.length === 0) throw new Error('The dropped folder holds no songs');
  const int = (v: unknown) => { const n = Number.parseInt(String(Array.isArray(v) ? v[0] : v ?? ''), 10); return Number.isFinite(n) && n > 0 ? n : null; };
  const links = new Map(planTrackLinks(
    read.map((r) => ({
      id: r.relPath, discNo: int(r.fields.discnumber), trackNo: int(r.fields.tracknumber),
      titleGuess: (r.fields.title as string | null) ?? path.posix.basename(r.relPath).replace(/\.[^.]+$/, ''),
      artistGuess: (r.fields.artist as string | null) ?? null, durationMs: r.durationMs,
    })),
    canon,
  ).map((l) => [l.id, l]));
  const canonById = new Map(canon.map((c) => [c.id, c]));
  const onDisc = new Map<number, number>();
  for (const r of read) {
    const c = links.get(r.relPath)?.canonicalTrackId ? canonById.get(links.get(r.relPath)!.canonicalTrackId!) : undefined;
    if (c) onDisc.set(c.mediumNo ?? 1, (onDisc.get(c.mediumNo ?? 1) ?? 0) + 1);
  }

  // Already in library (this release's group, now): the old copy goes first (Replace), so its folder is free for the rules
  let existingAlbumId = await heldAlbum(ctx, row.libraryId, releaseId);
  if (row.query?.existing === 'replace' && existingAlbumId) {
    await trashExisting(ctx, row.libraryId, existingAlbumId);
    existingAlbumId = null;
  }

  const fields = Object.values(CanonicalField) as CanonicalField[];
  const paired: Array<{ r: (typeof read)[number]; c: (typeof canon)[number]; diff: TagDiffEntry[]; after: Record<string, unknown>; distance: number }> = [];
  const unpaired: typeof read = [];
  for (const r of read) {
    const link = links.get(r.relPath);
    const c = link?.canonicalTrackId ? canonById.get(link.canonicalTrackId) : undefined;
    if (!link || !c) { unpaired.push(r); continue; }
    const resolved = await resolveForTarget(ctx, row.libraryId, {
      releaseId, canonicalTrackId: c.id, fileScopes: [], targetAlbumId: null, localMediumTrackCount: onDisc.get(c.mediumNo ?? 1) ?? 0,
    });
    const diff: TagDiffEntry[] = [];
    const after: Record<string, unknown> = { ...r.fields };
    for (const field of fields) {
      const current = r.fields[field] ?? null;
      const res = resolved?.[field];
      const d = decideField(fieldPolicyFor(IMPORT_POLICY, field), current, res?.value === undefined ? null : res.value, res?.source === 'lock');
      if (d.reason === 'locked' || d.reason === 'no-change') continue;
      diff.push({ field, before: current, after: d.after, reason: d.reason });
      after[field] = d.after;
    }
    paired.push({ r, c, diff, after, distance: link.distance });
  }
  if (paired.length === 0) throw new Error('No song pairs with a track of that release');

  const { rules } = await namingRulesFor(ctx, row.libraryId);
  const soundtrack = rel.types.some((t) => t.toLowerCase() === 'soundtrack');
  const planned = albumPaths(rules, paired.map((p) => ({ relPath: p.r.relPath, fields: p.after as Record<string, string | string[] | null> })), { soundtrack });
  let toDir = planned.dir;
  let names = new Map(planned.files.map((p) => [p.relPath, p.toPath]));
  if (row.query?.existing === 'keepBoth' || existingAlbumId) {
    // a folder of its own beside the library's copy
    let n = 2;
    while (await onDisk(root.path, `${planned.dir} (${n})`)) n++;
    toDir = `${planned.dir} (${n})`;
    names = new Map(planned.files.map((p) => [p.relPath, `${toDir}/${path.posix.basename(p.toPath)}`]));
  }
  const albumDir = albumDirOf(read.map((r) => r.relPath), (b) => discDirNumber(b) !== null);
  const moving = new Set(paired.map((p) => p.r.relPath));
  const extras = await companionFiles(root.path, albumDir, moving, toDir);

  const files: MovePlanFile[] = [];
  const taken = new Map<string, number>();
  for (const p of names.values()) taken.set(fold(p), (taken.get(fold(p)) ?? 0) + 1);
  for (const p of paired) {
    const toPath = names.get(p.r.relPath)!.normalize('NFC');
    files.push({
      fileId: null, localTrackId: null, title: (p.r.fields.title as string | null) ?? path.posix.basename(p.r.relPath),
      fromPath: p.r.relPath, toPath,
      target: { canonicalTrackId: p.c.id, disc: p.c.mediumNo ?? 1, position: p.c.position ?? 0, title: p.c.title },
      confidence: moveConfidence(p.distance), diff: p.diff, stays: null,
      clash: taken.get(fold(toPath))! > 1 || !!(await onDisk(root.path, toPath)),
    });
  }
  for (const r of unpaired) {
    files.push({
      fileId: null, localTrackId: null, title: (r.fields.title as string | null) ?? path.posix.basename(r.relPath), fromPath: r.relPath,
      toPath: null, target: null, confidence: null, diff: [], stays: 'Not on this release', clash: false,
    });
  }
  const plan: MovePlan = {
    scanRootId: item.rootId,
    toDir,
    newFolder: !(await onDisk(root.path, toDir)),
    naming: rules.file,
    release: { id: rel.id, mbid: rel.mbid, title: rel.title, artist: albumArtist, year: yearOf(rel.firstDate) ?? yearOf(rel.date), tracks: canon.length },
    files,
    extras: extras.filter((e) => !samePath(e.fromPath, e.toPath)),
    // the emptied drop folder goes into the trash, never the pool itself
    ...(pool.dirPath && pool.scanRootId === item.rootId ? { keepDir: pool.dirPath } : {}),
  };
  return { plan, existingAlbumId };
}

/** After the import's move (or its plan) ended: the pool item says how. */
export async function afterImport(ctx: Pick<WorkerContext, 'sql'>, row: { id: string; query: ImportRow['query'] }): Promise<void> {
  const itemId = row.query?.poolItemId;
  if (!itemId) return;
  const [m] = (await ctx.sql`select state, error from album_moves where id = ${row.id}`) as unknown as Array<{ state: string; error: string | null }>;
  if (m?.state === 'done') {
    await ctx.sql`update pool_items set state = 'imported', reason = null, error = null, move_id = ${row.id}, decided_at = now(), updated_at = now()
                   where id = ${itemId}`;
  } else if (m && m.state !== 'moving') {
    await ctx.sql`update pool_items set state = 'inbox', reason = 'failed', error = ${m.error}, move_id = ${row.id}, updated_at = now()
                   where id = ${itemId}`;
  }
}

/** An undone import: its library rows go (the files are back in the pool), the item waits, skipped. */
export async function afterImportUndone(ctx: WorkerContext, row: { id: string; query: ImportRow['query'] }, importedIds: string[]): Promise<void> {
  if (importedIds.length) {
    // dropped as a deletion is: marked first, so the rows (and an album left empty) go the one way
    await ctx.sql`
      insert into file_deletions (file_id, library_id, scan_root_id, kind, state, rel_path)
      select id, library_id, scan_root_id, 'mark', 'marked', rel_path from files where id = any(${importedIds}::uuid[])
      on conflict (file_id) do nothing`;
    await dropDeletedFiles(ctx, importedIds);
  }
  const itemId = row.query?.poolItemId;
  if (!itemId) return;
  await ctx.sql`update pool_items set state = 'skipped', reason = 'undone', error = null, updated_at = now() where id = ${itemId}`;
}

/** Queues an import of a pool item as this release (the pool's confident path, and Inbox's Accept and Pick). */
export async function queueImport(
  ctx: Pick<WorkerContext, 'sql' | 'boss'>,
  libraryId: string,
  itemId: string,
  releaseId: string,
  opts: { existing?: 'replace' | 'keepBoth'; createdBy?: string | null } = {},
): Promise<string> {
  const [row] = (await ctx.sql`
    insert into album_moves (library_id, kind, source_track_ids, release_id, state, query, created_by)
    values (${libraryId}, 'import', '{}'::uuid[], ${releaseId}, 'planning',
            ${JSON.stringify({ poolItemId: itemId, releaseId, ...(opts.existing ? { existing: opts.existing } : {}) })}::jsonb, ${opts.createdBy ?? null}::uuid)
    returning id::text as id`) as unknown as Array<{ id: string }>;
  await ctx.sql`update pool_items set state = 'importing', move_id = ${row!.id}, error = null, updated_at = now() where id = ${itemId}`;
  await ctx.boss.send('files.move', { moveId: row!.id, action: 'plan' }, { singletonKey: `files.move:${row!.id}:plan` });
  return row!.id;
}
