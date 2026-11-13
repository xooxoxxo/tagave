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
 * Verified tracks and the source's destination are recorded before publication.
 * After interruption, the next attempt checks those files before continuing.
 */
import { randomUUID } from 'node:crypto';
import { link, mkdir, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import {
  expectedBoundariesMs, frameRms, msToSample, planSplit, refineCut, resolveFields, verifySplit, windowAround,
  type PlanTrackInput, type RefinedCut, type ResolutionInput,
} from '@tagave/core';
import { oneFileAlbums, writableRootIds, type OneFileAlbum } from '@tagave/db';
import {
  ONE_FILE_ALBUM_GAP, TRASH_DIR, SPLIT_LENGTH_SLACK_MS, SPLIT_SEARCH_MS, type FilesSplitJobData, type SplitPlan, type TagPolicies, type TagSet,
} from '@tagave/shared';
import { currentFieldsFrom } from '../lib/canonicalTags.js';
import { decideField, fieldPolicyFor } from './tagsPreview.js';
import type { WorkerContext } from '../lib/context.js';
import { ensureTrashDir, markLibraryDirty, onDisk, trashDay, trashRelPath } from '../lib/deletions.js';
import { FlacTools } from '../lib/flacTools.js';
import { relDirname } from '../lib/helpers.js';
import { MutagenTagWriter } from '../lib/tagWriter.js';
import { runMaintenance, type MaintenanceRun } from '../lib/maintenance.js';
import { fileDigest, fileStat, insideRoot, mountIdentity } from '../lib/fileRecovery.js';

export interface SplitDeps {
  tools: FlacTools;
  /** the tag writer (mutagen); tests pass a stand-in */
  tags: { write(path: string, tags: TagSet): Promise<unknown> };
  now?: () => Date;
  /** Called at durable boundaries, including on resume. */
  beforeWrite?: () => Promise<unknown>;
  checkpoint?: (stage: string) => Promise<unknown>;
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
  id: string; libraryId: string; localAlbumId: string | null; state: string; plan: SplitPlan | null; createdBy: string | null; writeCheckpoint: SplitCheckpoint | null;
}

export interface CanonRow {
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
    select id::text as id, library_id::text as "libraryId", local_album_id::text as "localAlbumId", state, plan, write_checkpoint as "writeCheckpoint",
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
                values (${row.libraryId}, ${row.createdBy}, ${action}, 'local_album', ${row.localAlbumId}, ${JSON.stringify(payload)}::text::jsonb)`;
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
export async function analyzeSplit(ctx: WorkerContext, row: SplitRow, deps: SplitDeps, claim?: MaintenanceRun): Promise<Record<string, unknown>> {
  try {
    const src = await loadSource(ctx, row);
    const plan = await planFromFile(deps.tools, src.abs,
      src.tracks.map((t) => ({ disc: t.mediumNo, position: t.position, title: t.title, lengthMs: t.lengthMs })));
    await claim?.current();
    const updated = await ctx.sql`
      update album_splits set state = 'ready', plan = ${JSON.stringify(plan)}::text::jsonb, file_id = ${src.album.fileId},
             release_id = ${src.album.releaseId}, error = null, updated_at = now()
       where id = ${row.id} and state = 'analyzing' returning id`;
    return { state: updated.length ? 'ready' : 'cancelled', tracks: plan.tracks.length, low: plan.tracks.filter((t) => t.confidence === 'low').length };
  } catch (err) {
    await claim?.current();
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

interface SplitCheckpoint {
  album: OneFileAlbum;
  root: string;
  mount: string;
  source: string;
  sourceDigest: string;
  trash: string;
  staging: string;
  digests: string[] | null;
}

async function newCheckpoint(src: Source, now: Date): Promise<SplitCheckpoint> {
  await insideRoot(src.root, src.abs);
  let trash = trashRelPath(src.album.relPath, trashDay(now));
  for (let n = 2; await fileStat(path.join(src.root, trash)); n++) {
    trash = trashRelPath(src.album.relPath, `${trashDay(now)}-${n}`);
  }
  return {
    album: src.album, root: src.root, mount: await mountIdentity(src.root),
    source: src.abs, sourceDigest: await fileDigest(src.abs), trash,
    staging: path.join(path.dirname(src.abs), `.tagave-split-${randomUUID()}`), digests: null,
  };
}

async function saveCheckpoint(ctx: WorkerContext, row: SplitRow, checkpoint: SplitCheckpoint): Promise<void> {
  const changed = await ctx.sql`update album_splits set write_checkpoint = ${JSON.stringify(checkpoint)}::text::jsonb,
    updated_at = now() where id = ${row.id} and state = 'splitting'`;
  if (!changed.count) throw new SplitStop('This split can no longer be written');
}

async function splitParts(ctx: WorkerContext, src: Source, plan: SplitPlan, temps: string[], deps: SplitDeps): Promise<string[]> {
  const info = await deps.tools.streamInfo(src.abs);
  if (info.totalSamples !== plan.totalSamples || info.sampleRate !== plan.sampleRate) throw new SplitStop('The file changed since the plan');
  if (src.tracks.length !== plan.tracks.length) throw new SplitStop('The release changed since the plan');
  const released = await releaseTags(ctx, src.album.releaseId, src.tracks);
  let tags = released;
  if (deps.policy) {
    const [f] = await ctx.sql<{ tagsRaw: unknown }[]>`select tags_raw as "tagsRaw" from files where id = ${src.album.fileId}`;
    const source = currentFieldsFrom(f?.tagsRaw ?? null) as Record<string, FieldValue | undefined>;
    tags = new Map([...released].map(([id, t]) => [id, splitTagsUnderPolicy(deps.policy!, source, t)]));
  }
  for (const [index, track] of plan.tracks.entries()) {
    await deps.beforeWrite?.();
    await deps.tools.encodePart(src.abs, track.startSample, track.endSample, temps[index]!);
    await deps.tags.write(temps[index]!, tags.get(src.tracks[index]!.id)!);
  }
  const written = [];
  for (const temp of temps) {
    const decodes = await deps.tools.decodes(temp);
    written.push({ decodes, samples: decodes ? (await deps.tools.streamInfo(temp)).totalSamples : -1 });
  }
  const problems = verifySplit(plan, written, SPLIT_LENGTH_SLACK_MS);
  if (problems.length) throw new SplitStop(problems.join('. '));
  return Promise.all(temps.map(fileDigest));
}

/** One journal is used by Split and Tag Plan Apply. Published tracks are immutable until the source is safe. */
export async function runSplit(ctx: WorkerContext, row: SplitRow, deps: SplitDeps): Promise<Record<string, unknown>> {
  const plan = row.plan;
  if (!plan) return fail(ctx, row, new Error('No plan'));
  let checkpoint = row.writeCheckpoint;
  let committed = false;
  try {
    const src = checkpoint?.digests ? null : await loadSource(ctx, row);
    checkpoint ??= await newCheckpoint(src!, deps.now?.() ?? new Date());
    const { album, root, mount, source, sourceDigest, staging, trash } = checkpoint;
    const [configured] = await ctx.sql<{ path: string }[]>`select path from scan_roots where id = ${album.scanRootId}`;
    if (configured?.path !== root || await mountIdentity(root) !== mount) throw new SplitStop('The music folder changed or is offline');
    if (!(await writableRootIds(ctx.sql, row.libraryId)).has(album.scanRootId)) throw new SplitStop('The music folder is read-only');
    await insideRoot(root, source);
    const directory = path.dirname(source);
    const finals = plan.tracks.map((track) => {
      if (path.basename(track.fileName) !== track.fileName || !track.fileName.endsWith('.flac')) throw new SplitStop('Invalid split track name');
      return path.join(directory, track.fileName);
    });
    const temps = plan.tracks.map((track) => path.join(staging, `.tagave-split-${track.n}.flac`));
    if (!checkpoint.digests) {
      if (await fileDigest(source) !== sourceDigest || src!.album.fileId !== album.fileId || src!.album.releaseId !== album.releaseId) {
        throw new SplitStop('The album changed since this split started');
      }
      for (const final of finals) {
        for (const candidate of new Set([final, final.normalize('NFD'), final.normalize('NFC')])) {
          if (await fileStat(candidate)) throw new SplitStop(`${path.basename(final)} is already in the folder`);
        }
      }
      await deps.beforeWrite?.();
      await saveCheckpoint(ctx, row, checkpoint);
      await deps.checkpoint?.('Writing and verifying tracks');
      await mkdir(staging, { recursive: true });
      if (!(await fileStat(staging))?.isDirectory()) throw new SplitStop('The split staging path changed');
      for (const temp of temps) await rm(temp, { force: true });
      checkpoint.digests = await splitParts(ctx, src!, plan, temps, deps);
      await saveCheckpoint(ctx, row, checkpoint);
    }
    if (!(await fileStat(staging))?.isDirectory()) throw new SplitStop('The split staging path changed');
    await insideRoot(root, temps[0]!);
    await deps.checkpoint?.('Publishing verified tracks');
    for (const [index, final] of finals.entries()) {
      const temp = temps[index]!;
      const expected = checkpoint.digests[index];
      if (await fileDigest(temp) !== expected) throw new SplitStop('A staged track changed after verification');
      await deps.beforeWrite?.();
      const existing = await fileStat(final);
      if (!existing) await link(temp, final);
      else {
        const staged = await fileStat(temp);
        if (!staged || existing.dev !== staged.dev || existing.ino !== staged.ino) throw new SplitStop(`${path.basename(final)} is already in the folder`);
      }
    }

    await deps.checkpoint?.('Moving the source to Trash');
    const dest = path.join(root, trash);
    if (await fileStat(source)) {
      if (await fileDigest(source) !== sourceDigest) throw new SplitStop('The original file changed');
      await deps.beforeWrite?.();
      await ensureTrashDir(root);
      await insideRoot(path.join(root, TRASH_DIR), dest);
      await mkdir(path.dirname(dest), { recursive: true });
      if (!await fileStat(dest)) await link(source, dest);
      const original = await fileStat(source);
      const moved = await fileStat(dest);
      if (!original || !moved || moved.dev !== original.dev || moved.ino !== original.ino) throw new SplitStop('The destination in Trash is already in use');
      await deps.beforeWrite?.();
      await unlink(source);
    }
    await insideRoot(root, dest);
    if (await fileDigest(dest) !== sourceDigest) throw new SplitStop('The original file could not be verified in Trash');
    await deps.checkpoint?.('Recording the split');
    const outputs = plan.tracks.map((track) => path.posix.join(relDirname(album.relPath), track.fileName).replace(/^\//, ''));
    await deps.beforeWrite?.();
    await ctx.sql.begin(async (tx) => {
      await tx`insert into file_deletions (file_id, library_id, scan_root_id, kind, state, rel_path, trash_rel_path, trash_mount, created_by, trashed_at)
        values (${album.fileId}, ${row.libraryId}, ${album.scanRootId}, 'trash', 'trashed', ${album.relPath}, ${trash}, ${mount}, ${row.createdBy}, now())`;
      await tx`update album_splits set state = 'done', outputs = ${outputs}, error = null, updated_at = now(), finished_at = now()
        where id = ${row.id}`;
      await tx`update gaps set state = 'resolved', resolved_at = now()
        where library_id = ${row.libraryId} and kind = ${ONE_FILE_ALBUM_GAP} and subject_id = ${album.albumId} and state != 'resolved'`;
      await tx`insert into audit_log (library_id, actor_user_id, action, subject_type, subject_id, payload)
        values (${row.libraryId}, ${row.createdBy}, 'album.split', 'local_album', ${row.localAlbumId},
          ${JSON.stringify({ splitId: row.id, source: album.relPath, trash, outputs, releaseId: album.releaseId })}::text::jsonb)`;
    });
    committed = true;
    await finishSplit(ctx, row, checkpoint);
    return { state: 'done', tracks: finals.length };
  } catch (err) {
    ctx.logger.warn({ splitId: row.id, err: (err as Error).message }, 'files.split stopped');
    if (committed) throw err;
    await deps.beforeWrite?.();
    // A verified stage may already be published. Leave it intact for Continue.
    if (checkpoint?.digests) {
      await ctx.sql`update album_splits set error = ${(err as Error).message}, updated_at = now() where id = ${row.id}`;
      return { state: 'interrupted', error: (err as Error).message };
    }
    if (checkpoint && await mountIdentity(checkpoint.root).catch(() => '') === checkpoint.mount &&
        (await fileStat(checkpoint.staging))?.isDirectory()) {
      await insideRoot(checkpoint.root, checkpoint.staging);
      await rm(checkpoint.staging, { recursive: true });
    }
    const result = await fail(ctx, row, err);
    await audit(ctx, row, 'album.split.failed', { splitId: row.id, error: result.error, source: checkpoint?.album.relPath ?? null });
    return result;
  }
}

export async function finishSplit(ctx: WorkerContext, row: SplitRow, checkpoint: SplitCheckpoint): Promise<void> {
  const { album, root, staging, mount } = checkpoint;
  if (await mountIdentity(root) !== mount) throw new SplitStop('The music folder is offline');
  await insideRoot(root, staging);
  if ((await fileStat(staging))?.isDirectory()) await rm(staging, { recursive: true });
  await markLibraryDirty(ctx, row.libraryId);
  const dirPath = relDirname(album.relPath);
  await ctx.boss.send('scan.dir', { scanRootId: album.scanRootId, dirPath, reason: 'split' }, { singletonKey: `scan.dir:${album.scanRootId}:${dirPath}` });
  await ctx.sql`update album_splits set write_checkpoint = null where id = ${row.id} and state = 'done'`;
}

function analysisDeps(): SplitDeps {
  return { tools: new FlacTools(), tags: { write: async () => { throw new Error('An analysis writes no tags'); } } };
}

/** files.split: one split's analysis, or the split itself. */
export async function filesSplitJob(ctx: WorkerContext, data: FilesSplitJobData, deps?: SplitDeps): Promise<Record<string, unknown>> {
  if (data.maintenance && data.action === 'split') {
    await runMaintenance(ctx, data.maintenance, async (claim) => {
      const row = await loadRow(ctx, data.splitId);
      if (!row || !row.plan) throw new SplitStop('This split has no plan');
      if (row.state === 'done') {
        if (row.writeCheckpoint) await finishSplit(ctx, row, row.writeCheckpoint);
        return { state: 'done', stage: 'Album split' };
      }
      if (!['splitting', 'failed'].includes(row.state)) throw new SplitStop('This split can no longer run');
      if (row.state === 'failed') {
        await ctx.sql`update album_splits set state = 'splitting', error = null, finished_at = null where id = ${row.id}`;
      }
      const checkpoints = {
        beforeWrite: claim.current,
        checkpoint: (stage: string) => claim.update({ stage, checkpoint: { splitId: row.id } }),
      };
      const result = await withSplitTools(deps, (tools) => runSplit(ctx, row, { ...tools, ...checkpoints }));
      return result.state === 'done'
        ? { state: 'done', stage: 'Album split' }
        : { state: result.state === 'interrupted' ? 'interrupted' : 'failed', stage: 'Split stopped', error: String(result.error) };
    });
    return {};
  }
  if (data.maintenance && data.action === 'analyze') {
    await runMaintenance(ctx, data.maintenance, async (claim) => {
      const row = await loadRow(ctx, data.splitId);
      if (row?.state === 'ready') return { state: 'done', stage: 'Cut points ready' };
      if (!row || !['analyzing', 'failed'].includes(row.state) || row.plan) throw new SplitStop('This split can no longer be analyzed');
      await claim.update({ stage: 'Finding cut points' });
      await ctx.sql`update album_splits set state = 'analyzing', error = null, finished_at = null where id = ${row.id} and plan is null`;
      const result = await analyzeSplit(ctx, row, deps ?? analysisDeps(), claim);
      return result.state === 'ready'
        ? { state: 'done', stage: 'Cut points ready' }
        : { state: 'failed', stage: 'Cut point analysis stopped', error: String(result.error ?? 'This split changed during analysis.') };
    });
    return {};
  }
  const row = await loadRow(ctx, data.splitId);
  if (!row) return { skipped: 'no such split' };
  const want = data.action === 'split' ? 'splitting' : 'analyzing';
  if (row.state !== want) return { skipped: `state ${row.state}` };
  if (data.action === 'analyze') return analyzeSplit(ctx, row, deps ?? analysisDeps());
  return withSplitTools(deps, (tools) => runSplit(ctx, row, tools));
}

async function withSplitTools<T>(deps: SplitDeps | undefined, run: (deps: SplitDeps) => Promise<T>): Promise<T> {
  if (deps) return run(deps);
  const tags = new MutagenTagWriter();
  try {
    return await run({ tools: new FlacTools(), tags });
  } finally {
    await tags.close();
  }
}
