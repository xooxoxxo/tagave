/**
 * How long the nightly Discogs↔MusicBrainz bridge (enrich.sweep) needs for
 * what is waiting on it: releases of matched albums that still miss one of
 * the two ids. The selection mirrors the sweep's own query.
 *
 * The sweep runs hourly 02:00–06:00; each run enqueues the library's pace
 * (settings.enrichSweepLimit, one of ENRICH_PACES; the first when unset).
 */
import type postgres from 'postgres';

type Sql = postgres.Sql<any> | postgres.TransactionSql<any>;

/** enrich.sweep runs per night (hourly 02:00–06:00) */
export const SWEEP_RUNS_PER_NIGHT = 5;
/** releases per sweep run the owner may pick; the first is the default */
export const ENRICH_PACES = [400, 800, 1600] as const;
export type EnrichPace = (typeof ENRICH_PACES)[number];

export interface DrainEstimate { pending: number; perNight: number; nights: number; limit: number }

export function isEnrichPace(n: unknown): n is EnrichPace {
  return typeof n === 'number' && (ENRICH_PACES as readonly number[]).includes(n);
}

/** The library's pace: its setting when that is one of ENRICH_PACES, else the first. */
export async function enrichPace(sql: Sql, libraryId: string): Promise<EnrichPace> {
  const [s] = await sql<Array<{ limit: number | null }>>`
    select case when jsonb_typeof(settings) = 'object' and jsonb_typeof(settings->'enrichSweepLimit') = 'number'
                then (settings->>'enrichSweepLimit')::numeric::int end as limit
      from libraries where id = ${libraryId}`;
  return isEnrichPace(s?.limit) ? s!.limit as EnrichPace : ENRICH_PACES[0];
}

/**
 * Releases waiting on the bridge in the library, or only those of a batch's
 * accepted albums, and the nights the current pace needs for them.
 */
export async function drainEstimate(sql: Sql, libraryId: string, batchId?: string): Promise<DrainEstimate> {
  const limit = await enrichPace(sql, libraryId);
  const batch = batchId ?? null;
  const [row] = await sql<Array<{ n: number }>>`
    select count(distinct r.id)::int as n from releases r
      join local_albums la on la.release_id = r.id and la.library_id = ${libraryId} and la.state = 'matched'
     where (r.discogs_release_id is null or r.mbid is null)
       and (r.bridge_attempted_at is null or r.bridge_attempted_at < now() - interval '30 days')
       and (${batch}::uuid is null or exists (
             select 1 from decider_batch_items i
              where i.batch_id = ${batch}::uuid and i.local_album_id = la.id and i.status = 'accepted'))`;
  const pending = row?.n ?? 0;
  const perNight = limit * SWEEP_RUNS_PER_NIGHT;
  return { pending, perNight, nights: Math.ceil(pending / perNight), limit };
}

/** drainEstimate for several batches of one library in one query: batch id → estimate (a batch with nothing waiting reads 0). */
export async function batchDrainEstimates(sql: Sql, libraryId: string, batchIds: readonly string[]): Promise<Map<string, DrainEstimate>> {
  const out = new Map<string, DrainEstimate>();
  if (batchIds.length === 0) return out;
  const limit = await enrichPace(sql, libraryId);
  const perNight = limit * SWEEP_RUNS_PER_NIGHT;
  const rows = await sql<Array<{ batch_id: string; n: number }>>`
    select i.batch_id, count(distinct r.id)::int as n
      from decider_batch_items i
      join local_albums la on la.id = i.local_album_id and la.library_id = ${libraryId} and la.state = 'matched'
      join releases r on r.id = la.release_id
     where i.batch_id = any(${[...batchIds]}::uuid[]) and i.status = 'accepted'
       and (r.discogs_release_id is null or r.mbid is null)
       and (r.bridge_attempted_at is null or r.bridge_attempted_at < now() - interval '30 days')
     group by i.batch_id`;
  const pending = new Map(rows.map((r) => [r.batch_id, r.n]));
  for (const id of batchIds) {
    const n = pending.get(id) ?? 0;
    out.set(id, { pending: n, perNight, nights: Math.ceil(n / perNight), limit });
  }
  return out;
}
