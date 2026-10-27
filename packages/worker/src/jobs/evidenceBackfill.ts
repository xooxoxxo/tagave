/**
 * evidence.backfill: write matching evidence for albums identified before
 * evidence was kept, by re-scoring their stored candidates (no network).
 * Distance, breakdown and evidence are rewritten together, so they agree.
 * Albums in review whose release data was never stored are identified again
 * at the sweep's pace; a hand-decided album is never re-identified (that could
 * replace the owner's decision). Restartable: each pass takes 200 albums in
 * id order and hands the next pass the last id it saw, so an album left
 * without evidence is not picked again until the next sweep.
 */
import { eq } from 'drizzle-orm';
import { albumEvidenceLock, localAlbums, localTracks } from '@tagave/db';
import { scoreCandidates, buildCandidateEvidence, stableJson, type AlbumEvidence } from '@tagave/core';
import type { WorkerContext } from '../lib/context.js';
import { localViewOf, toScorable } from './identifyAlbum.js';
import { storedReleases } from '../lib/storedRelease.js';
import { remoteInputOf, upsertAlbumEvidence } from '../lib/evidenceStore.js';
import { IDENTIFY_QUEUES } from '../lib/cancelIdentify.js';

export interface EvidenceBackfillJobData {
  libraryId?: string;
  limit?: number;
  /** where the previous pass stopped: albums with a greater id come next */
  afterId?: string;
}
export interface EvidenceBackfillResult {
  rescored: number;
  reidentify: number;
  left: number;
  /** albums whose evidence could not be built (logged by id; the pass goes on) */
  failed: number;
  more: boolean;
}

/**
 * What a rebuild did. `incomplete`: a candidate's release has no stored
 * tracks, so the album cannot be re-scored offline.
 */
export type RebuildOutcome = 'rescored' | 'incomplete' | 'no_tracks' | 'no_candidates' | 'gone';

export interface RebuildOptions {
  /** a candidate whose evidence was just built from the provider's own copy: left as written */
  except?: string;
  /**
   * When some candidate's release has no stored tracks. 'skip' (default)
   * writes nothing. 'clear' re-scores the others and drops that candidate's
   * evidence, which was built against tracks the album no longer has.
   */
  incomplete?: 'skip' | 'clear';
}

/** A rebuild whose reads went stale before its write (another write on the album got there first). */
export class EvidenceRebuildConflict extends Error {
  constructor(albumId: string, what: string) {
    super(`evidence rebuild: album ${albumId} changed since it was read (${what})`);
    this.name = 'EvidenceRebuildConflict';
  }
}

interface PlannedRow { id: string; distance: string; breakdown: string; evidence: string; old: string | null }

/** What a rebuild will write, built entirely before any write. */
export type RebuildPlan =
  | { kind: 'none'; outcome: RebuildOutcome }
  | {
    kind: 'write';
    albumId: string;
    /** the stored album evidence as read (stableJson), null when there was none */
    prevAlbum: string | null;
    albumEvidence: AlbumEvidence;
    rows: PlannedRow[];
    /** candidates whose release has no stored tracks: their stale evidence is dropped */
    clear: Array<{ id: string; old: string | null }>;
  };

/**
 * Build the rebuild of one album: read the album, its tracks, its stored
 * album evidence and its non-mc candidates, and score the candidates that
 * need it from the releases identification stored.
 *
 * Which candidates need it: when the stored album evidence equals the one
 * the current tracks give, the candidates holding evidence agree with it
 * and are left as they are (a pasted edition's evidence came from the
 * provider's own copy, richer than the stored one); only those without
 * evidence are scored. When it differs (or there is none), every
 * candidate's evidence was built against other tracks and all are scored.
 */
export async function planAlbumRebuild(ctx: WorkerContext, albumId: string, opts: RebuildOptions = {}): Promise<RebuildPlan> {
  const [album] = await ctx.db.select().from(localAlbums).where(eq(localAlbums.id, albumId));
  if (!album) return { kind: 'none', outcome: 'gone' };
  const tracks = await ctx.db.select().from(localTracks).where(eq(localTracks.localAlbumId, albumId));
  if (tracks.length === 0) return { kind: 'none', outcome: 'no_tracks' };
  const [prev] = await ctx.sql<Array<{ evidence: unknown }>>`select evidence from album_evidence where local_album_id = ${albumId}`;
  const cands = (await ctx.sql<Array<{ id: string; release_id: string; evidence: string | null }>>`
    select id, release_id, evidence::text as evidence from match_candidates
     where local_album_id = ${albumId} and source not like 'mc:%' order by id`)
    .filter((c) => c.id !== opts.except);

  // The scorer and the evidence read the same local track list
  // (localTrackViews, through localViewOf), so alignment indices line up.
  const { local, albumEvidence } = await localViewOf(ctx, album, tracks);
  const prevAlbum = prev ? stableJson(prev.evidence) : null;
  const allStale = prevAlbum !== stableJson(albumEvidence);
  const targets = allStale ? cands : cands.filter((c) => c.evidence === null);
  if (targets.length === 0) return { kind: 'none', outcome: 'no_candidates' };

  const stored = await storedReleases(ctx, [...new Set(targets.map((c) => c.release_id))]);
  const complete = targets.filter((c) => stored.get(c.release_id)?.complete);
  const missing = targets.filter((c) => !stored.get(c.release_id)?.complete);
  if (missing.length > 0 && (opts.incomplete ?? 'skip') === 'skip') return { kind: 'none', outcome: 'incomplete' };

  const releaseDbIds = [...new Set(complete.map((c) => c.release_id))];
  const scored = scoreCandidates(local, releaseDbIds.map((id) => toScorable(stored.get(id)!.release)));
  const byRemoteId = new Map(scored.map((s) => [s.id, s]));
  const rows = complete.map((c): PlannedRow => {
    const s = stored.get(c.release_id)!;
    const sc = byRemoteId.get(s.release.id);
    if (!sc) throw new Error(`evidence rebuild: release ${c.release_id} was not scored`);
    if (!Number.isFinite(sc.distance)) throw new RangeError(`evidence rebuild: release ${c.release_id} scored a distance that is not a finite number (${sc.distance})`);
    const evidence = buildCandidateEvidence(remoteInputOf(s.release, s.status), sc, local.tracks.length);
    return {
      id: c.id,
      distance: sc.distance.toFixed(4),
      breakdown: JSON.stringify(sc.breakdown),
      evidence: JSON.stringify(evidence),
      old: c.evidence,
    };
  });
  return { kind: 'write', albumId, prevAlbum, albumEvidence, rows, clear: missing.map((c) => ({ id: c.id, old: c.evidence })) };
}

/**
 * Write a planned rebuild in one transaction, under the album's evidence
 * lock. Every candidate must still be there with the evidence it was read
 * with, and the album evidence must be the one read: otherwise another write
 * (an identification replacing the candidates, a pasted edition) came first,
 * and the whole write rolls back with an EvidenceRebuildConflict.
 */
export async function writeAlbumRebuild(ctx: WorkerContext, plan: Extract<RebuildPlan, { kind: 'write' }>): Promise<void> {
  const { albumId, rows, clear } = plan;
  await ctx.sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtextextended(${albumEvidenceLock(albumId)}, 0))`;
    const [now] = await tx<Array<{ evidence: unknown }>>`select evidence from album_evidence where local_album_id = ${albumId}`;
    if ((now ? stableJson(now.evidence) : null) !== plan.prevAlbum) throw new EvidenceRebuildConflict(albumId, 'album evidence');
    if (rows.length > 0) {
      const res = await tx`
        update match_candidates mc
           set distance = t.distance, breakdown = t.breakdown::jsonb, evidence = t.evidence::jsonb
          from unnest(
            ${rows.map((r) => r.id)}::uuid[],
            ${rows.map((r) => r.distance)}::numeric[],
            ${rows.map((r) => r.breakdown)}::text[],
            ${rows.map((r) => r.evidence)}::text[],
            ${rows.map((r) => r.old)}::text[]
          ) as t(id, distance, breakdown, evidence, old)
         where mc.id = t.id and mc.local_album_id = ${albumId} and mc.evidence is not distinct from t.old::jsonb`;
      if (res.count !== rows.length) throw new EvidenceRebuildConflict(albumId, `${res.count} of ${rows.length} candidates`);
    }
    if (clear.length > 0) {
      const res = await tx`
        update match_candidates mc set evidence = null
          from unnest(${clear.map((c) => c.id)}::uuid[], ${clear.map((c) => c.old)}::text[]) as t(id, old)
         where mc.id = t.id and mc.local_album_id = ${albumId} and mc.evidence is not distinct from t.old::jsonb`;
      if (res.count !== clear.length) throw new EvidenceRebuildConflict(albumId, `${res.count} of ${clear.length} candidates to clear`);
    }
    await upsertAlbumEvidence(tx, albumId, plan.albumEvidence);
  });
}

/**
 * Re-score one album's candidates from the releases identification stored
 * and rebuild their evidence and the album's, against the album's current
 * tracks (planAlbumRebuild says which candidates). Linked-app suggestions
 * (source mc:<link>) are the linked app's and are not touched. The lock is
 * not held while building. A builder that throws (an alignment outside the
 * tracklists) throws here, as does a write that lost a race.
 */
export async function rebuildAlbumEvidence(ctx: WorkerContext, albumId: string, opts: RebuildOptions = {}): Promise<RebuildOutcome> {
  const plan = await planAlbumRebuild(ctx, albumId, opts);
  if (plan.kind === 'none') return plan.outcome;
  await writeAlbumRebuild(ctx, plan);
  return plan.clear.length > 0 ? 'incomplete' : 'rescored';
}

/**
 * Albums with an identification queued or running, read once per pass.
 * Test databases (and a fresh install before pg-boss starts) may have no
 * pgboss.job: then there are none.
 */
async function albumsBeingIdentified(ctx: WorkerContext): Promise<string[]> {
  const [r] = await ctx.sql<Array<{ ok: boolean }>>`select to_regclass('pgboss.job') is not null as ok`;
  if (!r?.ok) return [];
  const rows = await ctx.sql<Array<{ id: string }>>`
    select distinct j.data->>'localAlbumId' as id from pgboss.job j
     where j.name = any(${[...IDENTIFY_QUEUES]}::text[]) and j.state in ('created', 'retry', 'active')
       and j.data->>'localAlbumId' is not null`;
  return rows.map((x) => x.id);
}

export async function evidenceBackfillJob(ctx: WorkerContext, data: EvidenceBackfillJobData): Promise<EvidenceBackfillResult> {
  const limit = data.limit ?? 200;
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError(`evidence backfill: limit must be a positive integer (${limit})`);
  const lib = data.libraryId ?? null;
  const after = data.afterId ?? null;
  // An album with an identification queued or running gets new candidates
  // (and their evidence) from it: re-scoring the old ones now is wasted work.
  const busy = await albumsBeingIdentified(ctx);
  const albums = await ctx.sql<Array<{ id: string; state: string }>>`
    select la.id, la.state from local_albums la
     where (${lib}::uuid is null or la.library_id = ${lib}::uuid)
       and (${after}::uuid is null or la.id > ${after}::uuid)
       and (la.state in ('needs_review', 'unidentified', 'as_is')
            or (la.state = 'matched' and exists (select 1 from album_matches am where am.local_album_id = la.id
                                                  and am.status in ('auto', 'confirmed') and am.decided_by = 'user')))
       and exists (select 1 from match_candidates mc where mc.local_album_id = la.id and mc.source not like 'mc:%' and mc.evidence is null)
       and la.id::text <> all(${busy}::text[])
     order by la.id
     limit ${limit + 1}`;
  const batch = albums.slice(0, limit);
  const result: EvidenceBackfillResult = { rescored: 0, reidentify: 0, left: 0, failed: 0, more: albums.length > limit };
  for (const a of batch) {
    let outcome: RebuildOutcome;
    try {
      outcome = await rebuildAlbumEvidence(ctx, a.id);
    } catch (err) {
      // One album's bad data must not stop the sweep; it stays without
      // evidence and is counted, by id only.
      result.failed += 1;
      ctx.logger.error({ localAlbumId: a.id, err: (err as Error).message }, 'evidence backfill: album failed');
      continue;
    }
    if (outcome === 'rescored') {
      result.rescored += 1;
    } else if (outcome === 'incomplete' && (a.state === 'needs_review' || a.state === 'unidentified')) {
      // the identify sweep's own key and priority: queued behind owner requests
      await ctx.boss.send('identify.album', { localAlbumId: a.id, force: true }, { singletonKey: `identify:${a.id}`, priority: 0 });
      result.reidentify += 1;
    } else {
      result.left += 1;
    }
  }
  if (result.more) {
    // No singletonSeconds: a throttled send can be swallowed, and a lost
    // send would end the sweep halfway.
    await ctx.boss.send('evidence.backfill', { ...data, afterId: batch[batch.length - 1]!.id }, { singletonKey: 'evidence.backfill' });
  }
  ctx.logger.info({ ...result, libraryId: lib }, 'evidence backfill pass');
  return result;
}
