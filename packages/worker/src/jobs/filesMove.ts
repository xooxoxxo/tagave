/**
 * files.move: Move to album (0080 album_moves; vault "tagave - Move to
 * Album"). Songs whose files sit in the wrong album's folder move, files and
 * tags, into another album's folder. Rides with the tag writer, the other job
 * that writes the music folder.
 *
 * search  MusicBrainz releases by artist and title (identify's search, its
 *         cache and its 1 req/s pace); the owner picks one.
 * plan    each file pairs with a track of the target release, by the
 *         alignment and weak-pair rule of the album's own track linking
 *         (planTrackLinks), among the tracks the target album does not hold
 *         yet. Its new path follows the target folder's names (or
 *         "NN - Title.ext"); a release with no folder gets
 *         "<Album artist>/<Year> - <Album>" under the files' root. Its tag
 *         changes are a tag plan's (the canonical preset, locks kept).
 * move    the tags first (SafeFileWriter: a temp copy, the audio hash checked
 *         unchanged, then swapped in), then each file into its new name, never
 *         over a file (a hard link refuses a taken name). A name taken
 *         anywhere stops the move before anything changes; any later failure
 *         puts back what was done (names, then tags). The file rows keep their
 *         ids (plays, playlists and links stay). An emptied source folder goes
 *         into the root's trash, never rmdir. Both folders are scanned again
 *         and the albums relinked (a new album is matched to its release).
 * undo    from the journal: each file back to its old name, its old tags
 *         written back, the source folder out of the trash, pins restored.
 *
 * Each step leaves an audit_log entry.
 */
import { link, mkdir, readdir, rename, stat, unlink } from 'node:fs/promises';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseFile } from 'music-metadata';
import {
  DEFAULT_NAMING, describeNaming, folderNaming, movedFileName, newAlbumDir,
  type NamingPattern, type ReleaseCandidate, type ReleaseQuery,
} from '@tagave/core';
import { tagSnapshotOf } from '@tagave/core/files';
import { writableRootIds } from '@tagave/db';
import {
  CanonicalField, IDENTIFY_REQUESTED_BY_OWNER, TRASH_DIR, moveConfidence,
  type FilesMoveJobData, type MoveCandidate, type MoveJournal, type MoveJournalFile, type MovePlan, type MovePlanFile,
  type TagDiffEntry, type TagPolicies, type TagSet,
} from '@tagave/shared';
import type { WorkerContext } from '../lib/context.js';
import { exists, ensureTrashDir, markLibraryDirty, onDisk, trashDay } from '../lib/deletions.js';
import { relDirname } from '../lib/helpers.js';
import { currentFieldsFrom } from '../lib/canonicalTags.js';
import { resolveForTarget } from '../lib/resolvedMetadata.js';
import { linkAlbumTracks, planTrackLinks } from '../lib/trackLinks.js';
import { requestPlayerRescan } from '../lib/playerScan.js';
import { getProviders, libraryProviderSettings } from '../lib/providers.js';
import { SafeFileWriter, type WriteResult } from '../lib/safeFileWriter.js';
import { MutagenTagWriter } from '../lib/tagWriter.js';
import { decideField, fieldPolicyFor } from './tagsPreview.js';
import { fieldsToWriteFrom, fileStateAfterWrite } from './tagsApply.js';
import { revertDiffsFor } from './tagsRevert.js';
import { mbRelease, mbSearch, persistFetched } from './identifyAlbum.js';
import { scanDirJob } from './scanDir.js';
import { clusterDirJob, retireEmptyAlbums } from './clusterDir.js';

/** The tag plan preset a move writes with: ids and album fields overwritten, titles and genres filled. */
const MOVE_POLICY: TagPolicies = { preset: 'canonical_ids_and_fill', id3Version: '2.4', multiValueSeparator: '; ' };

export interface MoveDeps {
  /** writes tags safely (the audio hash unchanged); tests pass a SafeFileWriter over a stand-in */
  writer: { write(filePath: string, tags: TagSet, opts?: { id3Version?: '2.3' | '2.4'; multiValueSeparator?: string }): Promise<WriteResult> };
  /** MusicBrainz release search; defaults to identify's (cached, paced) */
  search?: (q: ReleaseQuery) => Promise<ReleaseCandidate[]>;
  /** fetches and stores a MusicBrainz release; defaults to identify's */
  fetchRelease?: (mbid: string) => Promise<{ releaseId: string }>;
  now?: () => Date;
}

export interface MoveRow {
  id: string; libraryId: string; sourceAlbumId: string | null; targetAlbumId: string | null;
  releaseId: string | null; releaseMbid: string | null; trackIds: string[]; state: string;
  query: { artist: string; title: string } | null; plan: MovePlan | null; journal: MoveJournal | null;
  createdBy: string | null; undoRequested: boolean;
}

class MoveStop extends Error {}

async function loadRow(ctx: WorkerContext, moveId: string): Promise<MoveRow | null> {
  const [r] = (await ctx.sql`
    select id::text as id, library_id::text as "libraryId", source_album_id::text as "sourceAlbumId",
           target_album_id::text as "targetAlbumId", release_id::text as "releaseId", release_mbid::text as "releaseMbid",
           source_track_ids::text[] as "trackIds", state, query, plan, journal, created_by::text as "createdBy",
           undo_requested as "undoRequested"
      from album_moves where id = ${moveId}`) as unknown as MoveRow[];
  return r ?? null;
}

async function fail(ctx: WorkerContext, row: MoveRow, err: unknown, from: string): Promise<{ state: 'failed'; error: string }> {
  const error = err instanceof Error ? err.message : String(err);
  await ctx.sql`update album_moves set state = 'failed', error = ${error}, updated_at = now(), finished_at = now()
                 where id = ${row.id} and state = ${from}`;
  return { state: 'failed', error };
}

async function audit(ctx: Pick<WorkerContext, 'sql'>, row: MoveRow, action: string, payload: Record<string, unknown>): Promise<void> {
  await ctx.sql`insert into audit_log (library_id, actor_user_id, action, subject_type, subject_id, payload)
                values (${row.libraryId}, ${row.createdBy}, ${action}, 'local_album', ${row.sourceAlbumId}, ${JSON.stringify(payload)}::jsonb)`;
}

const yearOf = (d: unknown): number | null => {
  const s = d instanceof Date ? d.toISOString() : typeof d === 'string' ? d : '';
  const y = Number(s.slice(0, 4));
  return Number.isInteger(y) && y > 0 ? y : null;
};

function creditName(raw: unknown): string {
  if (!Array.isArray(raw)) return '';
  return raw.map((c: unknown) => {
    if (typeof c === 'string') return c;
    const o = (c ?? {}) as { name?: unknown; joinPhrase?: unknown };
    return `${typeof o.name === 'string' ? o.name : ''}${typeof o.joinPhrase === 'string' ? o.joinPhrase : ''}`;
  }).join('').trim();
}

const join = (dir: string, name: string) => (dir === '' ? name : `${dir}/${name}`);
const fold = (p: string) => p.normalize('NFC').toLowerCase();

// ---------------------------------------------------------------- search

/** MusicBrainz releases for the owner's artist and title. */
export async function searchMove(ctx: WorkerContext, row: MoveRow, deps: Pick<MoveDeps, 'search'>): Promise<Record<string, unknown>> {
  try {
    const q = row.query;
    if (!q?.title) throw new MoveStop('Nothing to look up');
    const search = deps.search ?? (async (query: ReleaseQuery) => {
      const providers = getProviders(await libraryProviderSettings(ctx, row.libraryId));
      return mbSearch(ctx, providers, query);
    });
    const found = await search({ albumTitle: q.title, ...(q.artist ? { artistName: q.artist } : {}) });
    const seen = new Set<string>();
    const releases = found.filter((c) => c.release.source === 'musicbrainz' && !seen.has(c.release.id) && seen.add(c.release.id));
    const mbids = releases.map((c) => c.release.id);
    const local = mbids.length === 0 ? [] : (await ctx.sql`
      select r.mbid::text as mbid, la.id::text as id from local_albums la join releases r on r.id = la.release_id
       where la.library_id = ${row.libraryId} and la.state = 'matched' and r.mbid = any(${mbids}::text[])`) as unknown as Array<{ mbid: string; id: string }>;
    const localOf = new Map(local.map((l) => [l.mbid, l.id]));
    const candidates: MoveCandidate[] = releases.map(({ release: r }) => ({
      mbid: r.id,
      title: r.title,
      artist: r.artists.join(', '),
      year: r.year ?? yearOf(r.date),
      country: r.country ?? null,
      format: r.media ?? null,
      tracks: r.tracks.filter((t) => !t.isDataTrack && !t.isVideoTrack).length,
      localAlbumId: localOf.get(r.id) ?? null,
    }));
    await ctx.sql`update album_moves set state = 'choosing', candidates = ${JSON.stringify(candidates)}::jsonb, error = null, updated_at = now()
                   where id = ${row.id} and state = 'searching'`;
    return { state: 'choosing', candidates: candidates.length };
  } catch (err) {
    ctx.logger.warn({ moveId: row.id, err: (err as Error).message }, 'files.move: search failed');
    return fail(ctx, row, err, 'searching');
  }
}

// ---------------------------------------------------------------- plan

interface Moving {
  trackId: string; fileId: string; albumId: string | null; discNo: number | null; trackNo: number | null;
  title: string | null; artist: string | null; durationMs: number | null; origin: string;
  scanRootId: string; relPath: string; status: string; tagsRaw: unknown; deleted: boolean;
}

interface CanonRow {
  id: string; mediumNo: number | null; position: number | null; title: string; artistCredit: unknown;
  lengthMs: number | null; recordingMbid: string | null; trackMbid: string | null;
}

/** The release the move targets: the album's, a release already stored, or one fetched from MusicBrainz. */
async function targetRelease(ctx: WorkerContext, row: MoveRow, deps: Pick<MoveDeps, 'fetchRelease'>): Promise<{ releaseId: string; targetAlbumId: string | null }> {
  if (row.targetAlbumId) {
    const [a] = (await ctx.sql`
      select release_id::text as "releaseId", state from local_albums where id = ${row.targetAlbumId} and library_id = ${row.libraryId}`) as unknown as Array<{ releaseId: string | null; state: string }>;
    if (!a) throw new MoveStop('The album is gone');
    if (!a.releaseId || a.state !== 'matched') throw new MoveStop('The album is not identified');
    return { releaseId: a.releaseId, targetAlbumId: row.targetAlbumId };
  }
  if (!row.releaseMbid) throw new MoveStop('No album chosen');
  let [rel] = (await ctx.sql`
    select r.id::text as id from releases r
     where r.mbid = ${row.releaseMbid} and exists (select 1 from canonical_tracks c where c.release_id = r.id)`) as unknown as Array<{ id: string }>;
  if (!rel) {
    const fetch = deps.fetchRelease ?? (async (mbid: string) => {
      const providers = getProviders(await libraryProviderSettings(ctx, row.libraryId));
      return persistFetched(ctx, await mbRelease(ctx, providers, mbid));
    });
    rel = { id: (await fetch(row.releaseMbid)).releaseId };
  }
  // a local album that already holds the release is the target
  const [held] = (await ctx.sql`
    select id::text as id from local_albums
     where library_id = ${row.libraryId} and release_id = ${rel.id} and state = 'matched'
       and id is distinct from ${row.sourceAlbumId}::uuid
     order by track_count desc nulls last limit 1`) as unknown as Array<{ id: string }>;
  return { releaseId: rel.id, targetAlbumId: held?.id ?? null };
}

/** The folders of an album: the one most of its files are in, and per disc its own when the discs have folders. */
async function albumFolders(ctx: WorkerContext, albumId: string): Promise<{ rootId: string; dir: string; perDisc: Map<number, string> } | null> {
  const rows = (await ctx.sql`
    select f.scan_root_id::text as "rootId", f.rel_path as "relPath", coalesce(lt.disc_no, 1) as disc
      from local_tracks lt join files f on f.id = lt.audio_file_id
     where lt.local_album_id = ${albumId} and f.status = 'present'
       and not exists (select 1 from file_deletions fd where fd.file_id = f.id)`) as unknown as Array<{ rootId: string; relPath: string; disc: number }>;
  if (rows.length === 0) return null;
  const count = new Map<string, number>();
  for (const r of rows) {
    const k = `${r.rootId}\n${relDirname(r.relPath)}`;
    count.set(k, (count.get(k) ?? 0) + 1);
  }
  const top = [...count.entries()].sort((a, b) => b[1] - a[1])[0]![0];
  const [rootId, dir] = top.split('\n') as [string, string];
  const discDirs = new Map<number, Set<string>>();
  for (const r of rows) {
    if (r.rootId !== rootId) continue;
    const set = discDirs.get(r.disc) ?? new Set<string>();
    set.add(relDirname(r.relPath));
    discDirs.set(r.disc, set);
  }
  // discs have folders of their own only when each disc sits in exactly one, and no two share it
  const perDisc = new Map<number, string>();
  const used = new Set<string>();
  let own = discDirs.size > 1;
  for (const [disc, set] of discDirs) {
    if (set.size !== 1) { own = false; break; }
    const d = [...set][0]!;
    if (used.has(d)) { own = false; break; }
    used.add(d);
    perDisc.set(disc, d);
  }
  return { rootId, dir: own ? relDirname(perDisc.values().next().value!) : dir, perDisc: own ? perDisc : new Map() };
}

/** The names of the audio files in one folder (not below it). */
async function namesIn(ctx: WorkerContext, rootId: string, dir: string): Promise<string[]> {
  const rows = (await ctx.sql`
    select rel_path as "relPath" from files
     where scan_root_id = ${rootId} and status = 'present'
       and ${dir === '' ? ctx.sql`strpos(rel_path, '/') = 0` : ctx.sql`rel_path like ${`${dir.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}/%`} and strpos(substr(rel_path, ${dir.length + 2}), '/') = 0`}`) as unknown as Array<{ relPath: string }>;
  return rows.map((r) => r.relPath.slice(r.relPath.lastIndexOf('/') + 1));
}

/** Pairs, paths and tag changes ('planning' → 'ready'). */
export async function planMove(ctx: WorkerContext, row: MoveRow, deps: Pick<MoveDeps, 'fetchRelease'>): Promise<Record<string, unknown>> {
  try {
    const { releaseId, targetAlbumId } = await targetRelease(ctx, row, deps);
    if (targetAlbumId && targetAlbumId === row.sourceAlbumId) throw new MoveStop('The songs are on that album already');
    const [rel] = (await ctx.sql`
      select r.id::text as id, r.mbid::text as mbid, r.title, r.date, rg.first_release_date as "firstDate", rg.artist_credit as credit
        from releases r join release_groups rg on rg.id = r.release_group_id where r.id = ${releaseId}`) as unknown as Array<{
      id: string; mbid: string | null; title: string; date: unknown; firstDate: unknown; credit: unknown;
    }>;
    if (!rel) throw new MoveStop('The release is gone');
    const canon = (await ctx.sql`
      select id::text as id, medium_no as "mediumNo", position, title, artist_credit as "artistCredit", length_ms as "lengthMs",
             recording_mbid as "recordingMbid", track_mbid as "trackMbid"
        from canonical_tracks
       where release_id = ${releaseId} and not coalesce(is_data_track, false) and not coalesce(is_video, false)
       order by coalesce(medium_no, 1), position`) as unknown as CanonRow[];
    if (canon.length === 0) throw new MoveStop('The release has no tracklist');
    const albumArtist = creditName(rel.credit) || 'Unknown artist';
    const year = yearOf(rel.firstDate) ?? yearOf(rel.date);

    const moving = (await ctx.sql`
      select lt.id::text as "trackId", f.id::text as "fileId", lt.local_album_id::text as "albumId", lt.disc_no as "discNo",
             lt.track_no as "trackNo", lt.title_guess as title, lt.artist_guess as artist, lt.duration_ms as "durationMs",
             lt.origin, f.scan_root_id::text as "scanRootId", f.rel_path as "relPath", f.status, f.tags_raw as "tagsRaw",
             exists (select 1 from file_deletions fd where fd.file_id = f.id) as deleted
        from local_tracks lt join files f on f.id = lt.audio_file_id
       where lt.id = any(${row.trackIds}::uuid[]) and f.library_id = ${row.libraryId}
       order by coalesce(lt.disc_no, 1), lt.track_no nulls last, f.rel_path`) as unknown as Moving[];
    if (moving.length === 0) throw new MoveStop('The songs are gone');

    // where the files go
    const folders = targetAlbumId ? await albumFolders(ctx, targetAlbumId) : null;
    const rootId = folders?.rootId ?? moving[0]!.scanRootId;
    const [root] = (await ctx.sql`select path from scan_roots where id = ${rootId}`) as unknown as Array<{ path: string }>;
    if (!root) throw new MoveStop('The music folder is gone');
    const toDir = folders?.dir ?? newAlbumDir(albumArtist, rel.title, year);
    const newFolder = !folders && !(await onDisk(root.path, toDir));
    const pattern: NamingPattern = (await (async () => {
      const dirs = folders?.perDisc.size ? [...folders.perDisc.values()] : [toDir];
      const names = (await Promise.all(dirs.map((d) => namesIn(ctx, rootId, d)))).flat();
      return folderNaming(names, albumArtist);
    })()) ?? DEFAULT_NAMING;
    const discs = new Set(canon.map((c) => c.mediumNo ?? 1)).size;

    // pair each movable file with a track the target does not hold yet
    const taken = new Set(targetAlbumId ? ((await ctx.sql`
      select canonical_track_id::text as id from local_tracks
       where local_album_id = ${targetAlbumId} and canonical_track_id is not null`) as unknown as Array<{ id: string }>).map((r) => r.id) : []);
    const free = canon.filter((c) => !taken.has(c.id));
    const stays = new Map<string, string>();
    for (const m of moving) {
      if (m.origin === 'cue') stays.set(m.trackId, 'Part of a CUE image');
      else if (m.status !== 'present') stays.set(m.trackId, 'File missing');
      else if (m.deleted) stays.set(m.trackId, 'Deleted');
      else if (m.scanRootId !== rootId) stays.set(m.trackId, 'In another music folder');
      else if (targetAlbumId && m.albumId === targetAlbumId) stays.set(m.trackId, 'On that album already');
    }
    const movable = moving.filter((m) => !stays.has(m.trackId));
    const links = new Map(planTrackLinks(
      movable.map((m) => ({ id: m.trackId, discNo: m.discNo, trackNo: m.trackNo, titleGuess: m.title, artistGuess: m.artist, durationMs: m.durationMs })),
      free,
    ).map((l) => [l.id, l]));
    const canonById = new Map(canon.map((c) => [c.id, c]));

    // the target disc's tracks after the move (totaltracks is only trusted when they add up)
    const onDisc = new Map<number, number>();
    if (targetAlbumId) {
      const rows = (await ctx.sql`
        select coalesce(disc_no, 1) as disc, count(*)::int as n from local_tracks
         where local_album_id = ${targetAlbumId} group by 1`) as unknown as Array<{ disc: number; n: number }>;
      for (const r of rows) onDisc.set(r.disc, r.n);
    }
    for (const m of movable) {
      const c = links.get(m.trackId)?.canonicalTrackId ? canonById.get(links.get(m.trackId)!.canonicalTrackId!) : undefined;
      if (c) onDisc.set(c.mediumNo ?? 1, (onDisc.get(c.mediumNo ?? 1) ?? 0) + 1);
    }

    const fields = Object.values(CanonicalField) as CanonicalField[];
    const files: MovePlanFile[] = [];
    for (const m of moving) {
      const base = { fileId: m.fileId, localTrackId: m.trackId, title: m.title ?? m.relPath.slice(m.relPath.lastIndexOf('/') + 1), fromPath: m.relPath };
      const link = links.get(m.trackId);
      const c = link?.canonicalTrackId ? canonById.get(link.canonicalTrackId) : undefined;
      if (stays.has(m.trackId) || !link || !c) {
        files.push({ ...base, toPath: null, target: null, confidence: null, diff: [], stays: stays.get(m.trackId) ?? 'Not on this release', clash: false });
        continue;
      }
      const disc = c.mediumNo ?? 1;
      const dir = folders?.perDisc.get(disc) ?? toDir;
      const name = movedFileName(pattern, {
        disc, position: c.position ?? 0, title: c.title, artist: creditName(c.artistCredit) || albumArtist, ext: path.extname(m.relPath),
      }, folders?.perDisc.size ? 1 : discs);
      const resolved = await resolveForTarget(ctx, row.libraryId, {
        releaseId, canonicalTrackId: c.id, fileScopes: [m.fileId, m.trackId], targetAlbumId,
        localMediumTrackCount: onDisc.get(disc) ?? 0,
      });
      const before = currentFieldsFrom(m.tagsRaw);
      const diff: TagDiffEntry[] = [];
      for (const field of fields) {
        const current = before[field] ?? null;
        const r = resolved?.[field];
        const decision = decideField(fieldPolicyFor(MOVE_POLICY, field), current, r?.value === undefined ? null : r.value, r?.source === 'lock');
        if (decision.reason === 'locked' || decision.reason === 'no-change') continue;
        diff.push({ field, before: current, after: decision.after, reason: decision.reason });
      }
      files.push({
        ...base,
        toPath: join(dir, name).normalize('NFC'),
        target: { canonicalTrackId: c.id, disc, position: c.position ?? 0, title: c.title },
        confidence: moveConfidence(link.distance),
        diff,
        stays: null,
        clash: false,
      });
    }
    // a name taken on disk, or two files given one name
    const names = new Map<string, number>();
    for (const f of files) if (f.toPath) names.set(fold(f.toPath), (names.get(fold(f.toPath)) ?? 0) + 1);
    for (const f of files) {
      if (!f.toPath || fold(f.toPath) === fold(f.fromPath)) continue;
      f.clash = names.get(fold(f.toPath))! > 1 || !!(await onDisk(root.path, f.toPath));
    }

    const plan: MovePlan = {
      scanRootId: rootId, toDir, newFolder, naming: describeNaming(pattern),
      release: { id: rel.id, mbid: rel.mbid, title: rel.title, artist: albumArtist, year, tracks: canon.length },
      files,
    };
    const updated = await ctx.sql`
      update album_moves set state = 'ready', plan = ${JSON.stringify(plan)}::jsonb, release_id = ${releaseId},
             target_album_id = ${targetAlbumId}, error = null, updated_at = now()
       where id = ${row.id} and state = 'planning' returning id`;
    return { state: updated.length ? 'ready' : 'superseded', files: files.length, moving: files.filter((f) => f.toPath).length };
  } catch (err) {
    ctx.logger.warn({ moveId: row.id, err: (err as Error).message }, 'files.move: planning failed');
    return fail(ctx, row, err, 'planning');
  }
}

// ---------------------------------------------------------------- move and undo

/** Puts `from` at `to` only if nothing is there: a hard link refuses a taken name; where links are not possible, look first and rename. */
async function placeNew(from: string, to: string): Promise<void> {
  try {
    await link(from, to);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') throw new MoveStop(`${path.basename(to)} is already in the folder`);
    for (const cand of new Set([to, to.normalize('NFD'), to.normalize('NFC')])) {
      if (await exists(cand)) throw new MoveStop(`${path.basename(to)} is already in the folder`);
    }
    await rename(from, to);
    return;
  }
  await unlink(from);
}

/** An empty folder into the root's trash (never rmdir): `.tagave-trash/<day>/<dir>`. Null when it holds anything. */
async function trashEmptyDir(root: string, dir: string, day: string): Promise<string | null> {
  if (dir === '') return null;
  const abs = await onDisk(root, dir);
  if (!abs) return null;
  if ((await readdir(abs)).length > 0) return null;
  await ensureTrashDir(root);
  let rel = `${TRASH_DIR}/${day}/${dir}`;
  for (let n = 2; await exists(path.join(root, rel)); n++) rel = `${TRASH_DIR}/${day}-${n}/${dir}`;
  await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await rename(abs, path.join(root, rel));
  return rel;
}

/** Empty folders from `dir` up to (and with) `top` go into the trash, deepest first. */
async function trashEmptyUpTo(root: string, dir: string, top: string, day: string): Promise<void> {
  for (let d = dir; d !== '' && (d === top || d.startsWith(`${top}/`)); d = relDirname(d)) {
    if (!(await trashEmptyDir(root, d, day))) return;
  }
}

/** Writes tags and records the file's new state (as tags.apply does). */
async function writeTags(ctx: WorkerContext, deps: MoveDeps, fileId: string, abs: string, diff: TagDiffEntry[]): Promise<void> {
  const fields = fieldsToWriteFrom(diff);
  if (Object.keys(fields).length === 0) return;
  const result = await deps.writer.write(abs, fields as TagSet, { id3Version: '2.4', multiValueSeparator: '; ' });
  if (result.error) throw new MoveStop(result.code === 'hash_mismatch' ? `${path.basename(abs)}: the audio would change` : `${path.basename(abs)}: ${result.error}`);
  const metadata = await parseFile(abs);
  const stats = await fs.stat(abs, { bigint: true });
  const state = fileStateAfterWrite({ size: stats.size, mtimeMs: Number(stats.mtimeMs), dev: stats.dev, ino: stats.ino }, tagSnapshotOf(metadata), '');
  await ctx.sql`
    update files set size_bytes = ${state.sizeBytes}, mtime = ${state.mtime}, inode = ${state.inode},
           tags_raw = ${JSON.stringify(state.tagsRaw)}::jsonb, tags_digest = ${state.tagsDigest},
           core_tags_digest = ${state.coreTagsDigest}, tags_read_at = now()
     where id = ${fileId}`;
}

const undoDiff = (f: MoveJournalFile): TagDiffEntry[] => revertDiffsFor(f.before, f.after);

interface Done {
  dirs: Array<{ rootId: string; dir: string }>;
  /** each moved file at its old and its new path (the player re-reads both folders) */
  paths: Array<{ fileId: string; rootId: string; relPath: string }>;
}

/**
 * After a move or an undo: both folders scanned and re-grouped, the albums
 * the files are in now relinked to their releases (a new album is matched to
 * the target release), the player told, the counts and checks refreshed.
 * Best effort: the files are where they belong whatever fails here.
 */
async function settle(ctx: WorkerContext, row: MoveRow, done: Done, matchTo: string | null): Promise<void> {
  const step = async (what: string, fn: () => Promise<unknown>) => {
    try { await fn(); } catch (err) { ctx.logger.warn({ moveId: row.id, what, err: (err as Error).message }, 'files.move: after the move'); }
  };
  const dirs = [...new Map(done.dirs.map((d) => [`${d.rootId}\n${d.dir}`, d])).values()];
  for (const d of dirs) await step('scan', () => scanDirJob(ctx, { scanRootId: d.rootId, dirPath: d.dir, reason: 'move' }));
  for (const d of dirs) await step('cluster', () => clusterDirJob(ctx, { libraryId: row.libraryId, scanRootId: d.rootId, dirPath: d.dir }));
  // an album left with no song in a folder the move emptied (clustering a folder that is gone does not reach it)
  await step('retire', () => retireEmptyAlbums(ctx, row.libraryId, dirs[0]?.dir ?? '', dirs.map((d) => d.dir)));
  const albums = (await ctx.sql`
    select distinct la.id::text as id, la.state, la.release_id::text as "releaseId"
      from local_tracks lt join local_albums la on la.id = lt.local_album_id
     where lt.audio_file_id = any(${[...new Set(done.paths.map((p) => p.fileId))]}::uuid[])
    union
    select la.id::text, la.state, la.release_id::text from local_albums la
     where la.id = any(${[row.sourceAlbumId, row.targetAlbumId].filter((x): x is string => !!x)}::uuid[])`) as unknown as Array<{ id: string; state: string; releaseId: string | null }>;
  const [rel] = matchTo ? (await ctx.sql`select mbid::text as mbid from releases where id = ${matchTo}`) as unknown as Array<{ mbid: string | null }> : [];
  for (const a of albums) {
    if (a.state === 'matched' && a.releaseId) await step('link', () => linkAlbumTracks(ctx, a.id));
    else if (matchTo && rel?.mbid) {
      // a new album of moved files: matched to the release the owner chose
      await step('identify', () => ctx.boss.send('identify.album', { localAlbumId: a.id, force: true, pinnedMbid: rel.mbid, requestedBy: IDENTIFY_REQUESTED_BY_OWNER },
        { singletonKey: `identify:${a.id}`, priority: 100 }));
    }
  }
  await step('player', async () => {
    const roots = new Map(((await ctx.sql`select id::text as id, path from scan_roots where id = any(${[...new Set(done.paths.map((p) => p.rootId))]}::uuid[])`) as unknown as Array<{ id: string; path: string }>).map((r) => [r.id, r.path]));
    await requestPlayerRescan(ctx, done.paths.map((p) => ({ libraryId: row.libraryId, fileId: p.fileId, scanRootPath: roots.get(p.rootId) ?? '', relPath: p.relPath })));
  });
  await step('gaps', () => ctx.boss.send('gaps.recompute', { libraryId: row.libraryId, albumIds: albums.map((a) => a.id) }, {}));
  await step('facets', () => markLibraryDirty(ctx, row.libraryId));
}

const pathsOf = (j: MoveJournal): Done['paths'] => j.files.flatMap((f) => [
  { fileId: f.fileId, rootId: j.scanRootId, relPath: f.fromPath },
  { fileId: f.fileId, rootId: j.scanRootId, relPath: f.toPath },
]);

async function saveJournal(ctx: WorkerContext, row: MoveRow, journal: MoveJournal): Promise<void> {
  await ctx.sql`update album_moves set journal = ${JSON.stringify(journal)}::jsonb, updated_at = now() where id = ${row.id}`;
}

/** Writes the tags, moves the files, leaves the journal ('moving' → 'done'). */
export async function runMove(ctx: WorkerContext, row: MoveRow, deps: MoveDeps): Promise<Record<string, unknown>> {
  const plan = row.plan;
  if (!plan) return fail(ctx, row, new Error('No plan'), 'moving');
  const day = trashDay(deps.now?.() ?? new Date());
  const work = plan.files.filter((f): f is MovePlanFile & { toPath: string } => !!f.toPath);
  const journal: MoveJournal = { scanRootId: plan.scanRootId, files: [], trashedDir: null, madeDir: null, pins: [] };
  let root = '';
  try {
    if (work.length === 0) throw new MoveStop('No song pairs with a track of that album');
    if (!(await writableRootIds(ctx.sql, row.libraryId)).has(plan.scanRootId)) throw new MoveStop('The music folder is read-only');
    const [r] = (await ctx.sql`select path from scan_roots where id = ${plan.scanRootId}`) as unknown as Array<{ path: string }>;
    if (!r) throw new MoveStop('The music folder is gone');
    root = r.path;
    // the files still where the plan found them, the new names all free
    const rows = (await ctx.sql`
      select id::text as id, rel_path as "relPath", scan_root_id::text as "rootId", status from files where id = any(${work.map((f) => f.fileId)}::uuid[])`) as unknown as Array<{ id: string; relPath: string; rootId: string; status: string }>;
    const byId = new Map(rows.map((x) => [x.id, x]));
    const sources = new Map<string, string>();
    const seen = new Set<string>();
    for (const f of work) {
      const now = byId.get(f.fileId);
      if (!now || now.status !== 'present' || now.relPath !== f.fromPath || now.rootId !== plan.scanRootId) throw new MoveStop(`${f.title}: the file changed since the preview`);
      const abs = await onDisk(root, f.fromPath);
      if (!abs) throw new MoveStop(`${f.title}: the file is not in its folder`);
      sources.set(f.fileId, abs);
      if (seen.has(fold(f.toPath))) throw new MoveStop(`${path.basename(f.toPath)} is given to two songs`);
      seen.add(fold(f.toPath));
      if (fold(f.toPath) !== fold(f.fromPath) && (await onDisk(root, f.toPath))) throw new MoveStop(`${path.basename(f.toPath)} is already in the folder`);
    }
    // one filesystem: a rename never copies
    const rootDev = (await stat(root)).dev;
    for (const abs of sources.values()) if ((await stat(abs)).dev !== rootDev) throw new MoveStop('On another disk than its music folder');

    // 1. the folder, when new
    const toAbs = path.join(root, plan.toDir);
    const made = await mkdir(toAbs, { recursive: true });
    if (made) journal.madeDir = path.relative(root, made).split(path.sep).join('/');
    for (const f of work) await mkdir(path.dirname(path.join(root, f.toPath)), { recursive: true });

    // 2. the tags, each file checked unchanged in its audio
    for (const f of work) {
      const entry: MoveJournalFile = {
        fileId: f.fileId, fromPath: f.fromPath, toPath: f.toPath, diff: f.diff,
        before: Object.fromEntries(f.diff.map((d) => [d.field, d.before])),
        after: Object.fromEntries(f.diff.map((d) => [d.field, d.after])),
        tagged: false, moved: false,
      };
      journal.files.push(entry);
      await writeTags(ctx, deps, f.fileId, sources.get(f.fileId)!, f.diff);
      entry.tagged = f.diff.length > 0;
    }
    await saveJournal(ctx, row, journal);

    // 3. the names, never over a file
    for (const entry of journal.files) {
      if (fold(entry.toPath) === fold(entry.fromPath)) continue;
      await placeNew(sources.get(entry.fileId)!, path.join(root, entry.toPath));
      entry.moved = true;
      await ctx.sql`update files set rel_path = ${entry.toPath} where id = ${entry.fileId}`;
    }
    await saveJournal(ctx, row, journal);
  } catch (err) {
    ctx.logger.warn({ moveId: row.id, err: (err as Error).message }, 'files.move: stopped, putting back');
    if (root) await putBack(ctx, row, deps, root, journal, day);
    const r = await fail(ctx, row, err, 'moving');
    await audit(ctx, row, 'album.move.failed', { moveId: row.id, error: r.error });
    return r;
  }

  // the moved files' pins to their old album go (the scan groups them by their new tags)
  const fileIds = journal.files.map((f) => f.fileId);
  journal.pins = (await ctx.sql`
    delete from cluster_overrides where audio_file_id = any(${fileIds}::uuid[])
    returning audio_file_id::text as "audioFileId", local_album_id::text as "localAlbumId"`) as unknown as MoveJournal['pins'];
  // an emptied source folder into the trash, never rmdir
  const fromDirs = [...new Set(journal.files.filter((f) => f.moved).map((f) => relDirname(f.fromPath)))];
  for (const d of fromDirs) {
    try {
      const rel = await trashEmptyDir(root, d, day);
      if (rel && !journal.trashedDir) journal.trashedDir = { dir: d, trashRelPath: rel };
    } catch (err) {
      ctx.logger.warn({ moveId: row.id, dir: d, err: (err as Error).message }, 'files.move: the emptied folder stays');
    }
  }
  const moved = journal.files.filter((f) => f.moved || f.tagged).length;
  await ctx.sql.begin(async (tx) => {
    await tx`update album_moves set state = 'done', journal = ${JSON.stringify(journal)}::jsonb, error = null, updated_at = now(), finished_at = now()
              where id = ${row.id}`;
    await tx`insert into audit_log (library_id, actor_user_id, action, subject_type, subject_id, payload)
             values (${row.libraryId}, ${row.createdBy}, 'album.move', 'local_album', ${row.sourceAlbumId},
                     ${JSON.stringify({ moveId: row.id, targetAlbumId: row.targetAlbumId, releaseId: plan.release.id, toDir: plan.toDir, files: journal.files.map((f) => ({ fileId: f.fileId, from: f.fromPath, to: f.toPath, fields: f.diff.map((d) => d.field) })), trashedDir: journal.trashedDir })}::jsonb)`;
  });
  ctx.logger.info({ moveId: row.id, files: moved }, 'files.move: done');
  await settle(ctx, row, {
    dirs: [...fromDirs.map((dir) => ({ rootId: plan.scanRootId, dir })), ...[...new Set(journal.files.map((f) => relDirname(f.toPath)))].map((dir) => ({ rootId: plan.scanRootId, dir }))],
    paths: pathsOf(journal),
  }, row.targetAlbumId ? null : plan.release.id);

  // Undo pressed while the move ran
  const [after] = (await ctx.sql`select undo_requested as u from album_moves where id = ${row.id}`) as unknown as Array<{ u: boolean }>;
  if (after?.u) {
    const claimed = await ctx.sql`update album_moves set state = 'undoing', updated_at = now() where id = ${row.id} and state = 'done' returning id`;
    if (claimed.length) {
      const fresh = await loadRow(ctx, row.id);
      if (fresh) return undoMove(ctx, fresh, deps);
    }
  }
  return { state: 'done', files: moved };
}

/**
 * Puts back what a journal says was done: names first (each file to its old
 * name, never over a file), then tags; the folders the move made and left
 * empty into the trash. Returns the problems; each entry is marked undone as
 * it goes, so a second run continues.
 */
async function putBack(ctx: WorkerContext, row: MoveRow, deps: MoveDeps, root: string, journal: MoveJournal, day: string): Promise<string[]> {
  const problems: string[] = [];
  if (journal.trashedDir) {
    try {
      const back = path.join(root, journal.trashedDir.dir);
      const from = path.join(root, journal.trashedDir.trashRelPath);
      if (!(await exists(back)) && (await exists(from))) {
        await mkdir(path.dirname(back), { recursive: true });
        await rename(from, back);
      }
      journal.trashedDir = null;
    } catch (err) {
      problems.push(`The old folder stays in the trash: ${(err as Error).message}`);
    }
  }
  for (const f of [...journal.files].reverse()) {
    try {
      if (f.moved) {
        const at = await onDisk(root, f.toPath);
        if (!at) throw new MoveStop(`${path.basename(f.toPath)} is not where the move put it`);
        await mkdir(path.dirname(path.join(root, f.fromPath)), { recursive: true });
        await placeNew(at, path.join(root, f.fromPath));
        f.moved = false;
        await ctx.sql`update files set rel_path = ${f.fromPath} where id = ${f.fileId}`;
      }
      if (f.tagged) {
        const at = await onDisk(root, f.fromPath);
        if (!at) throw new MoveStop(`${path.basename(f.fromPath)} is gone`);
        await writeTags(ctx, deps, f.fileId, at, undoDiff(f));
        f.tagged = false;
      }
    } catch (err) {
      problems.push((err as Error).message);
    }
  }
  if (journal.madeDir) {
    try {
      const dirs = [...new Set(journal.files.map((f) => relDirname(f.toPath)))].sort((a, b) => b.length - a.length);
      for (const d of dirs) await trashEmptyUpTo(root, d, journal.madeDir, day);
      await trashEmptyDir(root, journal.madeDir, day);
      journal.madeDir = null;
    } catch (err) {
      ctx.logger.warn({ moveId: row.id, err: (err as Error).message }, 'files.move: the made folder stays');
    }
  }
  return problems;
}

/** Undo from the journal ('undoing' → 'undone'; problems: back to 'done' with the reason, for another try). */
export async function undoMove(ctx: WorkerContext, row: MoveRow, deps: MoveDeps): Promise<Record<string, unknown>> {
  const journal = row.journal;
  const plan = row.plan;
  if (!journal || !plan) return fail(ctx, row, new Error('Nothing to undo'), 'undoing');
  const [r] = (await ctx.sql`select path from scan_roots where id = ${journal.scanRootId}`) as unknown as Array<{ path: string }>;
  if (!r) {
    await ctx.sql`update album_moves set state = 'done', error = 'The music folder is gone', updated_at = now() where id = ${row.id}`;
    return { state: 'done', error: 'The music folder is gone' };
  }
  const day = trashDay(deps.now?.() ?? new Date());
  const toDirs = [...new Set(journal.files.map((f) => relDirname(f.toPath)))];
  const fromDirs = [...new Set(journal.files.map((f) => relDirname(f.fromPath)))];
  const problems = await putBack(ctx, row, deps, r.path, journal, day);
  if (problems.length === 0) {
    // the pins the move lifted, where their albums still are
    for (const p of journal.pins) {
      await ctx.sql`
        insert into cluster_overrides (library_id, audio_file_id, local_album_id)
        select ${row.libraryId}, ${p.audioFileId}, ${p.localAlbumId}
         where exists (select 1 from files where id = ${p.audioFileId})
           and (${p.localAlbumId}::uuid is null or exists (select 1 from local_albums where id = ${p.localAlbumId}))
           and not exists (select 1 from cluster_overrides where audio_file_id = ${p.audioFileId})`;
    }
    journal.pins = [];
  }
  const state = problems.length === 0 ? 'undone' : 'done';
  const error = problems.length === 0 ? null : `Undo stopped: ${problems.join('; ')}`;
  await ctx.sql.begin(async (tx) => {
    await tx`update album_moves set state = ${state}, journal = ${JSON.stringify(journal)}::jsonb, error = ${error}, undo_requested = false,
                    updated_at = now(), undone_at = case when ${state} = 'undone' then now() else undone_at end
              where id = ${row.id}`;
    await tx`insert into audit_log (library_id, actor_user_id, action, subject_type, subject_id, payload)
             values (${row.libraryId}, ${row.createdBy}, ${problems.length ? 'album.move.undo_failed' : 'album.move.undone'}, 'local_album', ${row.sourceAlbumId},
                     ${JSON.stringify({ moveId: row.id, problems })}::jsonb)`;
  });
  await settle(ctx, row, { dirs: [...fromDirs, ...toDirs].map((dir) => ({ rootId: journal.scanRootId, dir })), paths: pathsOf(journal) }, null);
  return { state, problems: problems.length };
}

/** files.move: a search, a plan, the move itself, or its undo. */
export async function filesMoveJob(ctx: WorkerContext, data: FilesMoveJobData, deps?: MoveDeps): Promise<Record<string, unknown>> {
  const row = await loadRow(ctx, data.moveId);
  if (!row) return { skipped: 'no such move' };
  const want = { search: 'searching', plan: 'planning', move: 'moving', undo: 'undoing' }[data.action];
  if (row.state !== want) return { skipped: `state ${row.state}` };
  if (data.action === 'search') return searchMove(ctx, row, deps ?? {});
  if (data.action === 'plan') return planMove(ctx, row, deps ?? {});
  if (deps) return data.action === 'move' ? runMove(ctx, row, deps) : undoMove(ctx, row, deps);
  // the mutagen sidecar only to write, closed after
  const tags = new MutagenTagWriter();
  try {
    const writer = new SafeFileWriter(tags);
    return data.action === 'move' ? await runMove(ctx, row, { writer }) : await undoMove(ctx, row, { writer });
  } finally {
    await tags.close();
  }
}
