/**
 * Which albums a decider run sends; the payload preview picks its album by
 * the same rules. Only owner-started runs use it (no run is ever
 * scheduled). Every population needs album evidence, an album title
 * read from its tags (an album title made from a folder name is never sent,
 * and there is no placeholder for one), and at least one candidate that may
 * be sent: not excluded, not a linked app's suggestion (mc:<link>), with
 * evidence.
 *
 *   needs_review  the review queue (the default)
 *   weak          unidentified albums whose candidates were all weak; only
 *                 their best few candidates are sent
 *   backtest      the owner's own past decisions with candidates that
 *                 survived: accepted in the review queue, or kept as they are
 *   measure       a seeded random sample of the review queue plus its
 *                 largest albums, to measure cost and request size
 */
import type postgres from 'postgres';

type Sql = postgres.Sql<any>;

/** Which albums a run decides (decider_runs.population; @tagave/shared Population). */
export type DeciderPopulation = 'needs_review' | 'weak' | 'backtest' | 'measure';
/** The measure population's defaults: 190 sampled + the 10 largest = 200 albums. */
export const MEASURE_SAMPLE = 190;
export const MEASURE_LARGEST = 10;

export interface PopulationOptions { sample?: number; largest?: number; seed?: number }

/** The conditions every population shares, on local_albums aliased `la`. */
function sendable(sql: Sql) {
  return sql`la.title_source = 'tag'
    and exists (select 1 from album_evidence ae where ae.local_album_id = la.id)
    and exists (select 1 from match_candidates mc where mc.local_album_id = la.id
                   and mc.excluded is not true and mc.source not like 'mc:%' and mc.evidence is not null)`;
}

const ids = (rows: Array<{ id: string }>): string[] => rows.map((r) => r.id);

export async function populationAlbumIds(sql: Sql, libraryId: string, population: DeciderPopulation, opts: PopulationOptions = {}): Promise<string[]> {
  if (population === 'needs_review') {
    return ids(await sql<Array<{ id: string }>>`
      select la.id from local_albums la
       where la.library_id = ${libraryId} and la.state = 'needs_review' and ${sendable(sql)}
       order by la.id`);
  }
  if (population === 'weak') {
    return ids(await sql<Array<{ id: string }>>`
      select la.id from local_albums la
       where la.library_id = ${libraryId} and la.state = 'unidentified' and la.identify_reason = 'weak_candidates' and ${sendable(sql)}
       order by la.id`);
  }
  if (population === 'backtest') {
    // the owner's own decisions with candidates that survived: accepted in
    // the review queue, or kept as they are ("none of these")
    return ids(await sql<Array<{ id: string }>>`
      select la.id from local_albums la
       where la.library_id = ${libraryId} and ${sendable(sql)} and (
               la.state = 'as_is'
               or (la.state = 'matched' and exists (
                     select 1 from album_matches am where am.local_album_id = la.id
                        and am.status = 'confirmed' and am.decided_kind = 'user' and am.reason = 'accepted in review queue')))
       order by la.id`);
  }
  // measure: the largest albums of the review queue (tracks × sendable
  // candidates, which is what makes a request big), then a seeded random
  // sample of the rest, so `largest` + `sample` albums when there are enough
  const largest = ids(await sql<Array<{ id: string }>>`
    select la.id from local_albums la
     where la.library_id = ${libraryId} and la.state = 'needs_review' and ${sendable(sql)}
     order by (select count(*) from local_tracks lt where lt.local_album_id = la.id)
            * (select count(*) from match_candidates mc where mc.local_album_id = la.id
                  and mc.excluded is not true and mc.source not like 'mc:%') desc, la.id
     limit ${opts.largest ?? MEASURE_LARGEST}`);
  const sample = ids(await sql<Array<{ id: string }>>`
    select la.id from local_albums la
     where la.library_id = ${libraryId} and la.state = 'needs_review' and ${sendable(sql)}
       and not (la.id = any(${largest}::uuid[]))
     order by md5(la.id::text || ${String(opts.seed ?? 1)}), la.id
     limit ${opts.sample ?? MEASURE_SAMPLE}`);
  return [...largest, ...sample];
}

/**
 * The population an album of the library is in, by the same rules: 'weak'
 * or 'needs_review' by its state, else 'backtest'; null when no run would
 * send it (another state, another library, or not sendable).
 */
export async function albumPopulation(sql: Sql, libraryId: string, albumId: string): Promise<Exclude<DeciderPopulation, 'measure'> | null> {
  const [row] = await sql<Array<{ p: Exclude<DeciderPopulation, 'measure'> | null }>>`
    select case
             when la.state = 'needs_review' then 'needs_review'
             when la.state = 'unidentified' and la.identify_reason = 'weak_candidates' then 'weak'
             when la.state = 'as_is' or (la.state = 'matched' and exists (
                    select 1 from album_matches am where am.local_album_id = la.id
                       and am.status = 'confirmed' and am.decided_kind = 'user' and am.reason = 'accepted in review queue')) then 'backtest'
           end as p
      from local_albums la
     where la.id = ${albumId} and la.library_id = ${libraryId} and ${sendable(sql)}`;
  return row?.p ?? null;
}
