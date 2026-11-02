/**
 * decider.train: train a library's local decider on the owner's own
 * decisions and store it as the library's active model. Owner-started, one
 * per library at a time (stately queue, singletonKey decider.train:<id>);
 * a new model applies to runs started after it.
 *
 * What it reads (the training itself is @tagave/core's trainLocalModel):
 *   - the library's live matches (album_matches 'auto' or 'confirmed'); the
 *     owner decided a match when decided_kind or decided_by is 'user', any
 *     other was made automatically and never reversed
 *   - the candidates the owner rejected (album_matches 'rejected' by 'user')
 *   - each album's candidates that may be scored: never excluded, never a
 *     linked app's suggestion, each release once at its best distance; an
 *     album counts when its live match's release is one of them
 *   - for the owner's albums, the stored evidence, to score their tracklist
 *     groups as the decider will (each candidate its own group when the
 *     evidence is not all stored)
 *
 * Refused, with nothing stored, while the module is off, for a library
 * that is not there, and when the library has too few albums the owner
 * decided (or nothing to tell apart). Deterministic: the same data and seed
 * store the same version.
 */
import {
  TRAIN_SEED, TrainingRefused, localDeciderGroups, numericBreakdown, trainLocalModel,
  type LocalTrainMetrics, type LocalModel, type TrainResult, type TrainingAlbum, type TrainingRefusal,
} from '@tagave/core';
import { AUTOTAGGER_MODULE_ID, autotaggerEnabled, storeModel, type DeciderModelRow } from '@tagave/db';
import type { WorkerContext } from '../lib/context.js';
import { loadEvidenceMany } from '../lib/evidenceStore.js';
import { reportProgress } from './progress.js';

export interface DeciderTrainJobData { libraryId: string }

export interface TrainDeps {
  /** fewest owner albums (default @tagave/core MIN_OWNER_ALBUMS); tests use a small library */
  minOwnerAlbums?: number;
  seed?: number;
}

export type TrainRefusal = TrainingRefusal | 'module_off' | 'no_library';

export type TrainSummary =
  | { state: 'stored'; modelId: string; version: string; dataHash: string; counts: TrainResult['counts']; metrics: LocalTrainMetrics }
  | { state: 'refused'; reason: TrainRefusal; message: string };

type Sql = WorkerContext['sql'];

/** Owner albums whose evidence is read per query. */
const EVIDENCE_CHUNK = 200;

/** Every album the training can use, with its candidates, labels and (owner albums) tracklist groups. */
export async function loadTrainingAlbums(sql: Sql, libraryId: string): Promise<TrainingAlbum[]> {
  const matches = await sql<Array<{ album_id: string; release_id: string; status: string; owner: boolean }>>`
    select m.local_album_id::text as album_id, m.release_id::text as release_id, m.status,
           (m.decided_kind = 'user' or m.decided_by = 'user') as owner
      from album_matches m
     where m.library_id = ${libraryId}
       and (m.status in ('auto', 'confirmed') or (m.status = 'rejected' and m.decided_by = 'user'))`;
  if (matches.length === 0) return [];
  const candidates = await sql<Array<{
    album_id: string; release_id: string; distance: string; breakdown: unknown; acoustid_coverage: string | null;
    source_of_truth: string | null; release_group_id: string | null;
  }>>`
    with albums as (
      select local_album_id from album_matches
       where library_id = ${libraryId}
         and (status in ('auto', 'confirmed') or (status = 'rejected' and decided_by = 'user'))
       group by local_album_id
    )
    select distinct on (mc.local_album_id, mc.release_id)
           mc.local_album_id::text as album_id, mc.release_id::text as release_id, mc.distance::text as distance, mc.breakdown,
           mc.acoustid_coverage::text as acoustid_coverage, r.source_of_truth, r.release_group_id::text as release_group_id
      from match_candidates mc
      join albums a on a.local_album_id = mc.local_album_id
      join releases r on r.id = mc.release_id
     where mc.excluded is not true and mc.source not like 'mc:%'
     order by mc.local_album_id, mc.release_id, mc.distance, mc.id`;

  const byAlbum = new Map<string, TrainingAlbum>();
  const album = (id: string): TrainingAlbum => {
    let a = byAlbum.get(id);
    if (!a) byAlbum.set(id, (a = { albumId: id, label: null, rejected: [], candidates: [], groups: null, releaseGroups: {} }));
    return a;
  };
  for (const c of candidates) {
    const a = album(c.album_id);
    a.candidates.push({
      releaseId: c.release_id,
      distance: Number(c.distance),
      breakdown: numericBreakdown(c.breakdown),
      acoustidCoverage: c.acoustid_coverage === null ? null : Number(c.acoustid_coverage),
      provider: c.source_of_truth === 'discogs' ? 'discogs' : 'musicbrainz',
    });
    a.releaseGroups[c.release_id] = c.release_group_id;
  }
  for (const m of matches) {
    const a = byAlbum.get(m.album_id);
    if (!a || !(m.release_id in a.releaseGroups)) continue; // not among the album's scorable candidates
    if (m.status === 'rejected') a.rejected.push(m.release_id);
    else a.label = { releaseId: m.release_id, owner: m.owner };
  }
  const usable = [...byAlbum.values()].filter((a) => a.label !== null || a.rejected.length > 0);

  // the owner's albums are measured by their tracklist groups, as the decider will score them
  const owner = usable.filter((a) => a.label?.owner === true);
  for (let i = 0; i < owner.length; i += EVIDENCE_CHUNK) {
    const chunk = owner.slice(i, i + EVIDENCE_CHUNK);
    const loaded = await loadEvidenceMany(sql, chunk.map((a) => a.albumId));
    for (const a of chunk) {
      const ev = loaded.get(a.albumId);
      if (!ev || ev.partial || ev.candidates.length === 0) continue;
      a.groups = localDeciderGroups(ev.album, ev.candidates);
    }
  }
  return usable;
}

/** Load the library and train on it (TrainingRefused when it cannot be trained on). */
export async function trainLibrary(sql: Sql, libraryId: string, deps: TrainDeps = {}): Promise<TrainResult> {
  const albums = await loadTrainingAlbums(sql, libraryId);
  return trainLocalModel(albums, {
    seed: deps.seed ?? TRAIN_SEED,
    ...(deps.minOwnerAlbums !== undefined ? { minOwnerAlbums: deps.minOwnerAlbums } : {}),
  });
}

/** The row storeModel takes for a training's result. */
export function modelRow(libraryId: string, t: TrainResult) {
  return {
    libraryId, decider: 'local', version: t.version, featuresSchemaHash: t.model.featuresSchemaHash, model: t.model,
    dataHash: t.dataHash, counts: t.counts, metrics: t.metrics,
  };
}

export async function deciderTrainJob(ctx: WorkerContext, data: DeciderTrainJobData, deps: TrainDeps = {}): Promise<TrainSummary> {
  const { libraryId } = data;
  const refused = (reason: TrainRefusal, message: string): TrainSummary => {
    ctx.logger.info({ library: libraryId, reason }, 'decider training refused');
    return { state: 'refused', reason, message };
  };
  if (!(await autotaggerEnabled(ctx.sql))) return refused('module_off', `${AUTOTAGGER_MODULE_ID} is off here (Settings › Modules)`);
  const [lib] = await ctx.sql<Array<{ id: string }>>`select id from libraries where id = ${libraryId}`;
  if (!lib) return refused('no_library', 'no such library');

  let progressId: string | null = null;
  const progress = async (state: 'running' | 'completed' | 'failed', message: string, error?: string) => {
    progressId = await reportProgress(ctx, progressId, {
      libraryId, type: 'decider.train', subjectType: 'library', subjectId: libraryId, state, message, ...(error !== undefined ? { error } : {}),
    });
  };
  await progress('running', 'training');
  let trained: TrainResult;
  try {
    trained = await trainLibrary(ctx.sql, libraryId, deps);
  } catch (err) {
    if (err instanceof TrainingRefused) {
      await progress('failed', err.reason, err.message);
      return refused(err.reason, err.message);
    }
    await progress('failed', 'failed', err instanceof Error ? err.message : String(err));
    throw err;
  }
  // the switch is read again with the store, so a module turned off meanwhile stores nothing
  const stored = await ctx.sql.begin(async (tx) => {
    const [row] = await tx<Array<{ enabled: boolean }>>`select enabled from installed_modules where id = ${AUTOTAGGER_MODULE_ID} for share`;
    if (row?.enabled !== true) return null;
    return storeModel<LocalModel, LocalTrainMetrics>(tx, modelRow(libraryId, trained));
  }) as DeciderModelRow<LocalModel, LocalTrainMetrics> | null;
  if (!stored) {
    await progress('failed', 'module_off', `${AUTOTAGGER_MODULE_ID} was turned off`);
    return refused('module_off', `${AUTOTAGGER_MODULE_ID} was turned off during the training`);
  }
  await progress('completed', stored.version);
  ctx.logger.info({ library: libraryId, version: stored.version, counts: trained.counts }, 'local decider trained');
  return { state: 'stored', modelId: stored.id, version: stored.version, dataHash: stored.dataHash, counts: trained.counts, metrics: trained.metrics };
}
