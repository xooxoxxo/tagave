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
import { localAlbums, localTracks } from '@tagave/db';
import { scoreCandidates, buildCandidateEvidence } from '@tagave/core';
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

/**
 * Re-score one album's candidates from the releases identification stored
 * and rebuild their evidence and the album's, against the album's current
 * tracks. Linked-app suggestions (source mc:<link>) are the linked app's and
 * are not touched. Every row is built before anything is written; the
 * candidates and the album evidence are then written in one transaction.
 * A builder that throws (an alignment outside the tracklists) throws here.
 */
export async function rebuildAlbumEvidence(ctx: WorkerContext, albumId: string, opts: RebuildOptions = {}): Promise<RebuildOutcome> {
  const [album] = await ctx.db.select().from(localAlbums).where(eq(localAlbums.id, albumId));
  if (!album) return 'gone';
  const tracks = await ctx.db.select().from(localTracks).where(eq(localTracks.localAlbumId, albumId));
  if (tracks.length === 0) return 'no_tracks';
  const cands = (await ctx.sql<Array<{ id: string; release_id: string }>>`
    select id, release_id from match_candidates
     where local_album_id = ${albumId} and source not like 'mc:%' order by id`)
    .filter((c) => c.id !== opts.except);
  if (cands.length === 0) return 'no_candidates';

  const stored = await storedReleases(ctx, [...new Set(cands.map((c) => c.release_id))]);
  const complete = cands.filter((c) => stored.get(c.release_id)?.complete);
  const missing = cands.filter((c) => !stored.get(c.release_id)?.complete);
  if (missing.length > 0 && (opts.incomplete ?? 'skip') === 'skip') return 'incomplete';

  // The scorer and the evidence read the same local track list
  // (localTrackViews, through localViewOf), so alignment indices line up.
  const { local, albumEvidence } = await localViewOf(ctx, album, tracks);
  const releaseDbIds = [...new Set(complete.map((c) => c.release_id))];
  const scored = scoreCandidates(local, releaseDbIds.map((id) => toScorable(stored.get(id)!.release)));
  const byRemoteId = new Map(scored.map((s) => [s.id, s]));
  const rows = complete.map((c) => {
    const s = stored.get(c.release_id)!;
    const sc = byRemoteId.get(s.release.id);
    if (!sc) throw new Error(`evidence rebuild: release ${c.release_id} was not scored`);
    const evidence = buildCandidateEvidence(remoteInputOf(s.release, s.status), sc, local.tracks.length);
    return {
      id: c.id,
      distance: sc.distance.toFixed(4),
      breakdown: JSON.stringify(sc.breakdown),
      evidence: JSON.stringify(evidence),
    };
  });

  await ctx.sql.begin(async (tx) => {
    if (rows.length > 0) {
      await tx`
        update match_candidates mc
           set distance = t.distance, breakdown = t.breakdown::jsonb, evidence = t.evidence::jsonb
          from unnest(
            ${rows.map((r) => r.id)}::uuid[],
            ${rows.map((r) => r.distance)}::numeric[],
            ${rows.map((r) => r.breakdown)}::text[],
            ${rows.map((r) => r.evidence)}::text[]
          ) as t(id, distance, breakdown, evidence)
         where mc.id = t.id and mc.local_album_id = ${albumId}`;
    }
    if (missing.length > 0) {
      await tx`update match_candidates set evidence = null
                where local_album_id = ${albumId} and id = any(${missing.map((c) => c.id)}::uuid[])`;
    }
    await upsertAlbumEvidence(tx, albumId, albumEvidence);
  });
  return missing.length > 0 ? 'incomplete' : 'rescored';
}

/** Test databases (and a fresh install before pg-boss starts) may have no pgboss.job. */
async function hasJobTable(ctx: WorkerContext): Promise<boolean> {
  const [r] = await ctx.sql<Array<{ ok: boolean }>>`select to_regclass('pgboss.job') is not null as ok`;
  return !!r?.ok;
}

export async function evidenceBackfillJob(ctx: WorkerContext, data: EvidenceBackfillJobData): Promise<EvidenceBackfillResult> {
  const limit = data.limit ?? 200;
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError(`evidence backfill: limit must be a positive integer (${limit})`);
  const lib = data.libraryId ?? null;
  const after = data.afterId ?? null;
  // An album with an identification queued or running gets new candidates
  // (and their evidence) from it: re-scoring the old ones now is wasted work.
  const notQueued = (await hasJobTable(ctx))
    ? ctx.sql`and not exists (select 1 from pgboss.job j
                               where j.name = any(${[...IDENTIFY_QUEUES]}::text[]) and j.state in ('created', 'retry', 'active')
                                 and j.data->>'localAlbumId' = la.id::text)`
    : ctx.sql``;
  const albums = await ctx.sql<Array<{ id: string; state: string }>>`
    select la.id, la.state from local_albums la
     where (${lib}::uuid is null or la.library_id = ${lib}::uuid)
       and (${after}::uuid is null or la.id > ${after}::uuid)
       and (la.state in ('needs_review', 'unidentified', 'as_is')
            or (la.state = 'matched' and exists (select 1 from album_matches am where am.local_album_id = la.id
                                                  and am.status in ('auto', 'confirmed') and am.decided_by = 'user')))
       and exists (select 1 from match_candidates mc where mc.local_album_id = la.id and mc.source not like 'mc:%' and mc.evidence is null)
       ${notQueued}
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
