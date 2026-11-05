/**
 * files.split: a whole album in one FLAC becomes one FLAC per track (0078
 * album_splits; vault "tagave - Split Album Images"). Rides with the tag
 * writer, the other job that writes the music folder.
 *
 * analyze  the release's lengths give the expected cuts; each inner one moves
 *          to the quietest point within ±6 s of it, decoding only that
 *          window (@tagave/core › refineCut). The plan waits for the owner.
 * split    each track is re-encoded losslessly from its first to its last
 *          sample (flac --skip/--until -8, the source's rate and bits), tagged
 *          from the matched release, and checked: every file decodes
 *          (flac -t), each holds exactly its planned samples, together exactly
 *          the source's. Only then do the tracks take their names (never over
 *          a file) and the source move into the root's trash, as Deleting's
 *          Trash does (a file_deletions row: Restore puts it back). The folder
 *          is scanned again.
 *
 * Any failure deletes the files this job wrote (by their exact paths) and
 * leaves the source where it was. Each run leaves an audit_log entry.
 */
import { link, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import {
  expectedBoundariesMs, frameRms, msToSample, planSplit, refineCut, resolveFields, verifySplit, windowAround,
  type PlanTrackInput, type RefinedCut, type ResolutionInput,
} from '@tagave/core';
import { oneFileAlbums, writableRootIds, type OneFileAlbum } from '@tagave/db';
import {
  ONE_FILE_ALBUM_GAP, SPLIT_LENGTH_SLACK_MS, SPLIT_SEARCH_MS, type FilesSplitJobData, type SplitPlan, type TagPolicies, type TagSet,
} from '@tagave/shared';
import { currentFieldsFrom } from '../lib/canonicalTags.js';
import { decideField, fieldPolicyFor } from './tagsPreview.js';
import type { WorkerContext } from '../lib/context.js';
import { exists, markLibraryDirty, onDisk, trashDay, trashOne } from '../lib/deletions.js';
import { FlacTools } from '../lib/flacTools.js';
import { relDirname } from '../lib/helpers.js';
import { MutagenTagWriter } from '../lib/tagWriter.js';

export interface SplitDeps {
  tools: FlacTools;
  /** the tag writer (mutagen); tests pass a stand-in */
  tags: { write(path: string, tags: TagSet): Promise<unknown> };
  now?: () => Date;
  /**
   * 0089: the tag plan's policy when a plan splits first: each track takes
   * the plan's values (splitTagsUnderPolicy) instead of every release value.
   */
  policy?: TagPolicies;
}

/**
 * The fields a split track owns. The source's value of these describes the
 * whole file, not the track, so a new track starts without them.
 */
const TRACK_FIELDS = new Set([
  'title', 'artist', 'artistsort', 'musicbrainz_artistid', 'musicbrainz_recordingid', 'musicbrainz_releasetrackid', 'isrc',
  'tracknumber', 'totaltracks', 'discnumber', 'totaldiscs',
]);
/** Always written: without them the tracks would not know their name and order. */
const STRUCTURAL_FIELDS = ['title', 'tracknumber', 'totaltracks', 'discnumber', 'totaldiscs'];

type FieldValue = string | string[] | null;

/**
 * The tags a split track takes under a tag plan's policy. flac copies the
 * source's tags into every track, so a track starts with the source's album
 * fields and none of its own (TRACK_FIELDS); each value the release gives is
 * then decided as the plan's preview decides it (overwrite, fill, never). Its
 * title and position always go in.
 */
export function splitTagsUnderPolicy(policy: TagPolicies, source: Record<string, FieldValue | undefined>, release: TagSet): TagSet {
  const out: TagSet = {};
  for (const [field, canonical] of Object.entries(release)) {
    if (STRUCTURAL_FIELDS.includes(field)) {
      out[field] = canonical;
      continue;
    }
    const before: FieldValue = TRACK_FIELDS.has(field) ? null : (source[field] ?? null);
    const d = decideField(fieldPolicyFor(policy, field), before, (canonical ?? null) as FieldValue, false);
    if (d.reason === 'policy:fill' || d.reason === 'policy:overwrite') out[field] = d.after as string | string[];
  }
  return out;
}

export interface SplitRow {
  id: string; libraryId: string; localAlbumId: string | null; state: string; plan: SplitPlan | null; createdBy: string | null;
}

interface CanonRow {
  id: string; mediumNo: number; position: number; number: string | null; title: string; lengthMs: number;
  artistCredit: unknown; recordingMbid: string | null; trackMbid: string | null;
}

interface Source {
  album: OneFileAlbum;
  root: string;
  /** the file on disk (its NFC or NFD spelling) */
  abs: string;
  tracks: CanonRow[];
}

class SplitStop extends Error {}

async function loadRow(ctx: WorkerContext, splitId: string): Promise<SplitRow | null> {
  const [r] = (await ctx.sql`
    select id::text as id, library_id::text as "libraryId", local_album_id::text as "localAlbumId", state, plan,
           created_by::text as "createdBy"
      from album_splits where id = ${splitId}`) as unknown as SplitRow[];
  return r ?? null;
}

/** The album, still fitting the rule, its file on disk and the release's tracks. */
async function loadSource(ctx: WorkerContext, row: SplitRow): Promise<Source> {
  if (!row.localAlbumId) throw new SplitStop('The album is gone');
  const [album] = await oneFileAlbums(ctx.sql, row.libraryId, row.localAlbumId);
  if (!album) throw new SplitStop('The album is no longer one file that fits its release');
  const [root] = (await ctx.sql`select path from scan_roots where id = ${album.scanRootId}`) as unknown as Array<{ path: string }>;
  if (!root) throw new SplitStop('The music folder is gone');
  const abs = await onDisk(root.path, album.relPath);
  if (!abs) throw new SplitStop('The file is not in its folder');
  const tracks = (await ctx.sql`
    select id::text as id, coalesce(medium_no, 1) as "mediumNo", position, number, title, length_ms as "lengthMs",
           artist_credit as "artistCredit", recording_mbid as "recordingMbid", track_mbid as "trackMbid"
      from canonical_tracks
     where release_id = ${album.releaseId} and not coalesce(is_data_track, false) and not coalesce(is_video, false)
     order by coalesce(medium_no, 1), position`) as unknown as CanonRow[];
  return { album, root: root.path, abs, tracks };
}

async function fail(ctx: WorkerContext, row: SplitRow, err: unknown): Promise<{ state: 'failed'; error: string }> {
  const error = err instanceof Error ? err.message : String(err);
  await ctx.sql`update album_splits set state = 'failed', error = ${error}, updated_at = now(), finished_at = now() where id = ${row.id}`;
  return { state: 'failed', error };
}

async function audit(ctx: WorkerContext, row: SplitRow, action: string, payload: Record<string, unknown>): Promise<void> {
  await ctx.sql`insert into audit_log (library_id, actor_user_id, action, subject_type, subject_id, payload)
                values (${row.libraryId}, ${row.createdBy}, ${action}, 'local_album', ${row.localAlbumId}, ${JSON.stringify(payload)}::jsonb)`;
}

/**
 * The plan for one file: its STREAMINFO, no CUESHEET block, and each inner
 * cut refined in a ±6 s window decoded on its own.
 */
export async function planFromFile(tools: FlacTools, abs: string, tracks: PlanTrackInput[]): Promise<SplitPlan> {
  const info = await tools.streamInfo(abs);
  if (info.totalSamples <= 0 || info.sampleRate <= 0) throw new SplitStop('The file does not say how long it is');
  if (await tools.hasCueSheet(abs)) throw new SplitStop('The file holds a cue sheet');
  const expected = expectedBoundariesMs(tracks.map((t) => t.lengthMs)).map((ms) => msToSample(ms, info.sampleRate));
  const cuts: RefinedCut[] = [];
  for (const e of expected) {
    if (e >= info.totalSamples) {
      cuts.push({ sample: e, depthDb: null, confidence: 'low', moved: false });
      continue;
    }
    const w = windowAround(e, info.sampleRate, info.totalSamples, SPLIT_SEARCH_MS);
    const pcm = await tools.decodeWindow(abs, w.skip, w.until);
    const rms = frameRms(pcm, info.bitsPerSample, info.channels, info.sampleRate);
    cuts.push(refineCut({ rms, sampleRate: info.sampleRate, windowStartSample: w.skip, expectedSample: e }));
  }
  return planSplit({ tracks, sampleRate: info.sampleRate, channels: info.channels, bitsPerSample: info.bitsPerSample, totalSamples: info.totalSamples, cuts });
}

/** Finds the cut points and stores the plan ('analyzing' → 'ready'). */
export async function analyzeSplit(ctx: WorkerContext, row: SplitRow, deps: SplitDeps): Promise<Record<string, unknown>> {
  try {
    const src = await loadSource(ctx, row);
    const plan = await planFromFile(deps.tools, src.abs,
      src.tracks.map((t) => ({ disc: t.mediumNo, position: t.position, title: t.title, lengthMs: t.lengthMs })));
    const updated = await ctx.sql`
      update album_splits set state = 'ready', plan = ${JSON.stringify(plan)}::jsonb, file_id = ${src.album.fileId},
             release_id = ${src.album.releaseId}, error = null, updated_at = now()
       where id = ${row.id} and state = 'analyzing' returning id`;
    return { state: updated.length ? 'ready' : 'cancelled', tracks: plan.tracks.length, low: plan.tracks.filter((t) => t.confidence === 'low').length };
  } catch (err) {
    ctx.logger.warn({ splitId: row.id, err: (err as Error).message }, 'files.split: analysis failed');
    return fail(ctx, row, err);
  }
}

type Credit = { name: string; joinPhrase?: string; mbid?: string };
function creditsOf(raw: unknown): Credit[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((c: unknown) => {
    if (typeof c === 'string') return { name: c };
    const o = (c ?? {}) as { name?: unknown; joinPhrase?: unknown; mbid?: unknown };
    return {
      name: typeof o.name === 'string' ? o.name : '',
      ...(typeof o.joinPhrase === 'string' ? { joinPhrase: o.joinPhrase } : {}),
      ...(typeof o.mbid === 'string' ? { mbid: o.mbid } : {}),
    };
  }).filter((c) => c.name);
}
const isoDate = (d: unknown): string | undefined => (d instanceof Date ? d.toISOString().slice(0, 10) : typeof d === 'string' && d ? d.slice(0, 10) : undefined);

/** The tags of each track, from the matched release (resolveFields, as a tag plan writes them; no locks, no genres). */
export async function releaseTags(ctx: WorkerContext, releaseId: string, tracks: CanonRow[]): Promise<Map<string, TagSet>> {
  const [r] = (await ctx.sql`
    select r.title, r.date, r.country, r.barcode, r.status, r.track_count as "trackCount", r.labels, r.media, r.mbid,
           r.discogs_release_id as "discogsReleaseId",
           rg.title as "rgTitle", rg.primary_type as "primaryType", rg.first_release_date as "firstReleaseDate",
           rg.mbid as "rgMbid", rg.secondary_types as "secondaryTypes", rg.artist_credit as "artistCredit"
      from releases r join release_groups rg on rg.id = r.release_group_id
     where r.id = ${releaseId}`) as unknown as Array<Record<string, unknown>>;
  if (!r) throw new SplitStop('The matched release is gone');
  const albumCredits = creditsOf(r['artistCredit']);
  const discs = new Set(tracks.map((t) => t.mediumNo)).size;
  const perDisc = new Map<number, number>();
  for (const t of tracks) perDisc.set(t.mediumNo, (perDisc.get(t.mediumNo) ?? 0) + 1);
  const out = new Map<string, TagSet>();
  for (const t of tracks) {
    const date = isoDate(r['date']);
    const first = isoDate(r['firstReleaseDate']);
    const input: ResolutionInput = {
      release: {
        title: r['title'] as string,
        ...(date ? { date } : {}),
        ...(r['country'] ? { country: r['country'] as string } : {}),
        ...(r['barcode'] ? { barcode: r['barcode'] as string } : {}),
        ...(r['status'] ? { status: r['status'] as string } : {}),
        ...(r['trackCount'] ? { trackCount: Number(r['trackCount']) } : {}),
        labels: (r['labels'] as Array<{ name?: string; catalogNumber?: string }> | null) ?? [],
        media: (r['media'] as Array<{ format?: string }> | null) ?? [],
        ...(r['mbid'] ? { mbid: r['mbid'] as string } : {}),
        ...(r['discogsReleaseId'] ? { discogsReleaseId: Number(r['discogsReleaseId']) } : {}),
        artists: albumCredits,
      },
      releaseGroup: {
        title: r['rgTitle'] as string,
        ...(r['primaryType'] ? { primaryType: r['primaryType'] as string } : {}),
        ...(first ? { firstReleaseDate: first } : {}),
        ...(r['rgMbid'] ? { mbid: r['rgMbid'] as string } : {}),
        secondaryTypes: (r['secondaryTypes'] as string[] | null) ?? [],
        artistCredit: albumCredits,
      },
      track: {
        title: t.title,
        ...(t.number ? { number: t.number } : {}),
        position: t.position,
        mediumNo: t.mediumNo,
        artistCredit: creditsOf(t.artistCredit).length ? creditsOf(t.artistCredit) : albumCredits,
        ...(t.recordingMbid ? { mbid: t.recordingMbid } : {}),
        ...(t.trackMbid ? { trackMbid: t.trackMbid } : {}),
      },
      artistCredits: albumCredits,
      locks: [],
      // the split writes every track of its disc: the counts agree by construction
      mediumTrackCount: perDisc.get(t.mediumNo)!,
      localMediumTrackCount: perDisc.get(t.mediumNo)!,
    };
    const resolved = resolveFields(input);
    const tags: TagSet = {};
    for (const [field, v] of Object.entries(resolved)) {
      if (v.value !== undefined && v.value !== '' && !(Array.isArray(v.value) && v.value.length === 0)) tags[field] = v.value;
    }
    tags['tracknumber'] = String(t.position);
    tags['discnumber'] = String(t.mediumNo);
    tags['totaldiscs'] = String(discs);
    out.set(t.id, tags);
  }
  return out;
}

/** Puts `from` at `to` only if nothing is there: a hard link refuses an existing name; where links are not possible, look first and rename. */
async function placeNew(from: string, to: string): Promise<void> {
  try {
    await link(from, to);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') throw new SplitStop(`${path.basename(to)} is already in the folder`);
    if (await exists(to)) throw new SplitStop(`${path.basename(to)} is already in the folder`);
    await rename(from, to);
    return;
  }
  await unlink(from);
}

/** Writes the tracks, checks them, moves the source into the trash ('splitting' → 'done'). */
export async function runSplit(ctx: WorkerContext, row: SplitRow, deps: SplitDeps): Promise<Record<string, unknown>> {
  const plan = row.plan;
  if (!plan) return fail(ctx, row, new Error('No plan'));
  /** every path this job made, by exact path: the only files a failure deletes */
  const created = new Set<string>();
  let trashedAbs: string | null = null;
  let src: Source | null = null;
  try {
    src = await loadSource(ctx, row);
    if (!(await writableRootIds(ctx.sql, row.libraryId)).has(src.album.scanRootId)) throw new SplitStop('The music folder is read-only');
    const info = await deps.tools.streamInfo(src.abs);
    if (info.totalSamples !== plan.totalSamples || info.sampleRate !== plan.sampleRate) throw new SplitStop('The file changed since the plan');
    if (src.tracks.length !== plan.tracks.length) throw new SplitStop('The release changed since the plan');
    const dir = path.dirname(src.abs);
    const short = row.id.slice(0, 8);
    const parts = plan.tracks.map((t) => ({
      t, final: path.join(dir, t.fileName), temp: path.join(dir, `.tagave-split-${short}-${String(t.n).padStart(2, '0')}.flac`),
    }));
    for (const p of parts) {
      for (const cand of new Set([p.final, p.final.normalize('NFD'), p.final.normalize('NFC')])) {
        if (await exists(cand)) throw new SplitStop(`${p.t.fileName} is already in the folder`);
      }
      if (await exists(p.temp)) throw new SplitStop(`${path.basename(p.temp)} is already in the folder`);
    }
    const released = await releaseTags(ctx, src.album.releaseId, src.tracks);
    let tags = released;
    if (deps.policy) {
      const [f] = (await ctx.sql`select tags_raw as "tagsRaw" from files where id = ${src.album.fileId}`) as unknown as Array<{ tagsRaw: unknown }>;
      const source = currentFieldsFrom(f?.tagsRaw ?? null) as Record<string, FieldValue | undefined>;
      tags = new Map([...released].map(([id, t]) => [id, splitTagsUnderPolicy(deps.policy!, source, t)]));
    }

    // 1. write and tag each track under a hidden name the scan skips
    for (const p of parts) {
      created.add(p.temp);
      await deps.tools.encodePart(src.abs, p.t.startSample, p.t.endSample, p.temp);
      await deps.tags.write(p.temp, tags.get(src.tracks[p.t.n - 1]!.id)!);
    }
    // 2. check them: each decodes, each holds its samples, together the source's
    const written = [];
    for (const p of parts) {
      const decodes = await deps.tools.decodes(p.temp);
      const samples = decodes ? (await deps.tools.streamInfo(p.temp)).totalSamples : -1;
      written.push({ decodes, samples });
    }
    const problems = verifySplit(plan, written, SPLIT_LENGTH_SLACK_MS);
    if (problems.length > 0) throw new SplitStop(problems.join('; '));
    // 3. the tracks take their names, never over a file
    for (const p of parts) {
      await placeNew(p.temp, p.final);
      created.delete(p.temp);
      created.add(p.final);
    }
    // 4. the source into the trash, as Deleting's Trash moves it
    const out = await trashOne(src.root, src.album.relPath, trashDay(deps.now?.() ?? new Date()));
    if (out.outcome !== 'trashed') throw new SplitStop(out.error ?? 'The file could not go to the trash');
    trashedAbs = path.join(src.root, out.trashRelPath!);
    const outputs = parts.map((p) => path.posix.join(relDirname(src!.album.relPath), p.t.fileName).replace(/^\//, ''));
    await ctx.sql.begin(async (tx) => {
      await tx`insert into file_deletions (file_id, library_id, scan_root_id, kind, state, rel_path, trash_rel_path, created_by, trashed_at)
               values (${src!.album.fileId}, ${row.libraryId}, ${src!.album.scanRootId}, 'trash', 'trashed', ${src!.album.relPath},
                       ${out.trashRelPath!}, ${row.createdBy}, now())`;
      await tx`update album_splits set state = 'done', outputs = ${outputs}, error = null, updated_at = now(), finished_at = now()
                where id = ${row.id}`;
      await tx`update gaps set state = 'resolved', resolved_at = now()
                where library_id = ${row.libraryId} and kind = ${ONE_FILE_ALBUM_GAP} and subject_id = ${src!.album.albumId} and state != 'resolved'`;
      await tx`insert into audit_log (library_id, actor_user_id, action, subject_type, subject_id, payload)
               values (${row.libraryId}, ${row.createdBy}, 'album.split', 'local_album', ${row.localAlbumId},
                       ${JSON.stringify({ splitId: row.id, source: src!.album.relPath, trash: out.trashRelPath!, outputs, releaseId: src!.album.releaseId })}::jsonb)`;
    });
    created.clear();
    trashedAbs = null;
    await markLibraryDirty(ctx, row.libraryId);
    const dirPath = relDirname(src.album.relPath);
    await ctx.boss.send('scan.dir', { scanRootId: src.album.scanRootId, dirPath, reason: 'split' }, { singletonKey: `scan.dir:${src.album.scanRootId}:${dirPath}` });
    ctx.logger.info({ splitId: row.id, tracks: parts.length }, 'files.split: done');
    return { state: 'done', tracks: parts.length };
  } catch (err) {
    ctx.logger.warn({ splitId: row.id, err: (err as Error).message }, 'files.split: stopped, nothing kept');
    // the source back where it was, if it had gone into the trash
    if (trashedAbs && src) {
      try {
        await rename(trashedAbs, path.join(src.root, src.album.relPath));
      } catch (e) {
        ctx.logger.error({ splitId: row.id, err: (e as Error).message, trash: trashedAbs }, 'files.split: the source stays in the trash');
      }
    }
    for (const p of created) {
      try {
        await unlink(p);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') ctx.logger.error({ path: p, err: (e as Error).message }, 'files.split: could not remove a partial track');
      }
    }
    const r = await fail(ctx, row, err);
    await audit(ctx, row, 'album.split.failed', { splitId: row.id, error: r.error, source: src?.album.relPath ?? null });
    return r;
  }
}

/** files.split: one split's analysis, or the split itself. */
export async function filesSplitJob(ctx: WorkerContext, data: FilesSplitJobData, deps?: SplitDeps): Promise<Record<string, unknown>> {
  const row = await loadRow(ctx, data.splitId);
  if (!row) return { skipped: 'no such split' };
  const want = data.action === 'split' ? 'splitting' : 'analyzing';
  if (row.state !== want) return { skipped: `state ${row.state}` };
  if (deps) return data.action === 'split' ? runSplit(ctx, row, deps) : analyzeSplit(ctx, row, deps);
  const tools = new FlacTools();
  if (data.action !== 'split') return analyzeSplit(ctx, row, { tools, tags: { write: async () => { throw new Error('An analysis writes no tags'); } } });
  // the mutagen sidecar only for a split, closed after it
  const tags = new MutagenTagWriter();
  try {
    return await runSplit(ctx, row, { tools, tags });
  } finally {
    await tags.close();
  }
}
