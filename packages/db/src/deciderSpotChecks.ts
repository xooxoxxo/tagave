/**
 * Spot checks: the owner's verdicts on a random sample of a run's picks, per
 * band. They gate a band's batch accept through the Clopper-Pearson bound,
 * which holds only for a random sample, so:
 *
 * - The sample is drawn without replacement, uniformly from all of the
 *   band's picks in the run: the picks are put in one shuffled order fixed
 *   by the run's seed (md5 of the decision id and the seed), and each draw
 *   takes the next ones not drawn yet. A decision is never drawn twice
 *   (decider_spot_checks.decision_id is unique), and nothing here can add
 *   a chosen decision.
 * - Only `correct` and `wrong` are checks. `unsure` is counted apart and
 *   never counts toward the clean checks a band needs.
 * - A later verdict replaces the earlier one, with who gave it and when.
 *
 * This package depends on no other tagave package: bandTable gives the raw
 * counts and the caller applies the gate (@tagave/core bandGate).
 *
 * The module's tables may be missing (its migration never ran): the reads
 * then answer as for empty tables. Call them outside a transaction for
 * that (a failed statement ends a transaction).
 */
import type postgres from 'postgres';

type Sql = postgres.Sql<any> | postgres.TransactionSql<any>;

/** Postgres: relation does not exist (the module's migration has not run). */
const UNDEFINED_TABLE = '42P01';

async function orMissing<T>(read: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await read();
  } catch (err) {
    if ((err as { code?: string }).code === UNDEFINED_TABLE) return fallback;
    throw err;
  }
}

/** A verdict the owner can give; 'pending' is a drawn check without one. */
export type SpotCheckVerdict = 'correct' | 'wrong' | 'unsure';
export const SPOT_CHECK_VERDICTS: readonly SpotCheckVerdict[] = ['correct', 'wrong', 'unsure'];

/** The bands from the most to the least sure; any other band follows. */
const BAND_ORDER = ['p99', 'p97', 'p95', 'p90'];

/** The most a single draw takes. */
export const MAX_SPOT_CHECK_DRAW = 1000;

/**
 * Draw `count` more spot checks of `band` from the run's picks: the next
 * ones in the run's shuffled order that were not drawn yet (fewer when the
 * band has fewer left). Returns the new checks' ids.
 *
 * Called in a transaction, draws of one run wait for each other, so two
 * at once take different picks; outside one, a concurrent draw may take
 * fewer than asked, never the same pick twice.
 */
export async function drawSpotChecks(sql: Sql, runId: string, band: string, count: number): Promise<string[]> {
  if (!Number.isInteger(count) || count < 1 || count > MAX_SPOT_CHECK_DRAW) {
    throw new RangeError(`count must be a whole number from 1 to ${MAX_SPOT_CHECK_DRAW}`);
  }
  await sql`select pg_advisory_xact_lock(hashtext(${`decider.spot_checks:${runId}`}))`;
  // one time for the whole draw, read after the lock: draws list in the order they took their picks
  const [now] = await sql<Array<{ at: string }>>`select clock_timestamp()::text as at`;
  const at = now!.at;
  const rows = await sql<Array<{ id: string }>>`
    insert into decider_spot_checks (run_id, decision_id, band, drawn_at)
    select d.run_id, d.id, d.band, ${at}::timestamptz
      from decider_decisions d
      join decider_runs r on r.id = d.run_id
     where d.run_id = ${runId} and d.band = ${band} and d.outcome = 'pick'
       and not exists (select 1 from decider_spot_checks s where s.decision_id = d.id)
     order by md5(d.id::text || r.seed::text), d.id
     limit ${count}
    on conflict (decision_id) do nothing
    returning id::text as id`;
  return rows.map((r) => r.id);
}

/**
 * Set a drawn check's verdict (replacing any earlier one) with who gave it
 * and when. With `libraryId`, only a check of a run of that library. False
 * when there is no such check.
 */
export async function recordVerdict(sql: Sql, checkId: string, verdict: SpotCheckVerdict, userId: string, libraryId?: string): Promise<boolean> {
  if (!SPOT_CHECK_VERDICTS.includes(verdict)) throw new RangeError('verdict must be correct, wrong or unsure');
  const lib = libraryId ?? null;
  const done = await sql`
    update decider_spot_checks s
       set verdict = ${verdict}, checked_by_user_id = ${userId}, checked_at = now()
      from decider_runs r
     where s.id = ${checkId} and r.id = s.run_id and (${lib}::uuid is null or r.library_id = ${lib}::uuid)`;
  return done.count > 0;
}

/**
 * One band of a run, raw counts: `checked` = correct + wrong, `errors` =
 * wrong, `unsure` apart; `accepted` = picks whose album is in an accepted
 * item of one of this run's model batches.
 */
export interface BandCounts { band: string; picks: number; drawn: number; checked: number; errors: number; unsure: number; accepted: number }

/** The run's picks per band with their spot-check counts (bands with no pick are left out). */
export async function bandTable(sql: Sql, runId: string): Promise<BandCounts[]> {
  return orMissing(() => sql<BandCounts[]>`
    select d.band,
           count(*)::int as picks,
           count(s.id)::int as drawn,
           (count(*) filter (where s.verdict in ('correct', 'wrong')))::int as checked,
           (count(*) filter (where s.verdict = 'wrong'))::int as errors,
           (count(*) filter (where s.verdict = 'unsure'))::int as unsure,
           (count(*) filter (where exists (
              select 1 from decider_batch_items i join decider_batches b on b.id = i.batch_id
               where b.run_id = d.run_id and b.decided_kind = 'model' and i.status = 'accepted' and i.local_album_id = d.local_album_id)))::int as accepted
      from decider_decisions d
      left join decider_spot_checks s on s.decision_id = d.id
     where d.run_id = ${runId} and d.outcome = 'pick' and d.band is not null
     group by d.band
     order by array_position(${BAND_ORDER}::text[], d.band::text) nulls last, d.band`, [] as BandCounts[]);
}

/** A track as a spot check shows it: its title and length in whole seconds. */
export interface SpotCheckTrack { title: string | null; seconds: number | null }

/** One drawn check with what the owner needs to judge it (raw rows; the caller shapes them). */
export interface SpotCheckRow {
  id: string;
  band: string;
  verdict: string;
  albumId: string;
  albumTitle: string | null;
  albumArtist: string | null;
  albumYear: number | null;
  /** the album's tracks as the decision saw them (its stored evidence), else as scanned */
  albumTracks: SpotCheckTrack[];
  releaseId: string;
  releaseTitle: string | null;
  releaseDate: string | null;
  releaseCountry: string | null;
  releaseLabels: unknown;
  releaseMedia: unknown;
  releaseSource: string | null;
  releaseTracks: SpotCheckTrack[];
  probability: number | null;
  groupSize: number;
}

export interface SpotCheckFilter { band?: string | undefined; verdict?: 'pending' | SpotCheckVerdict | 'all' | undefined; limit: number; offset?: number | undefined }

const seconds = (ms: number | null): number | null => (ms === null || !(ms > 0) ? null : Math.round(ms / 1000));

function byKey(list: Array<{ key: string; title: string | null; ms: number | null }>): Map<string, SpotCheckTrack[]> {
  const out = new Map<string, SpotCheckTrack[]>();
  for (const t of list) {
    const tracks = out.get(t.key) ?? [];
    tracks.push({ title: t.title, seconds: seconds(t.ms) });
    out.set(t.key, tracks);
  }
  return out;
}

/** The run's drawn checks in the order they were drawn, filtered by band and verdict ('pending' by default). */
export async function spotChecks(sql: Sql, runId: string, filter: SpotCheckFilter): Promise<SpotCheckRow[]> {
  const band = filter.band ?? null;
  const verdict = filter.verdict === 'all' ? null : (filter.verdict ?? 'pending');
  const offset = filter.offset ?? 0;
  return orMissing(async () => {
    const rows = await sql<Array<{
      id: string; band: string; verdict: string; album_id: string; title_guess: string | null; artist_guess: string | null; year_guess: number | null;
      release_id: string; r_title: string | null; r_date: string | null; country: string | null; labels: unknown; media: unknown; source_of_truth: string | null;
      probability: string | null; group_size: number;
    }>>`
      select s.id::text as id, s.band, s.verdict, la.id::text as album_id, la.title_guess, la.artist_guess, la.year_guess,
             d.release_id::text as release_id, rel.title as r_title, rel.date::text as r_date, rel.country, rel.labels, rel.media, rel.source_of_truth,
             d.probability::text as probability, coalesce(cardinality(d.group_release_ids), 0)::int as group_size
        from decider_spot_checks s
        join decider_decisions d on d.id = s.decision_id
        join decider_runs r on r.id = s.run_id
        join local_albums la on la.id = d.local_album_id
        left join releases rel on rel.id = d.release_id
       where s.run_id = ${runId}
         and (${band}::text is null or s.band = ${band}::text)
         and (${verdict}::text is null or s.verdict = ${verdict}::text)
       order by s.drawn_at, md5(d.id::text || r.seed::text), d.id
       limit ${filter.limit} offset ${offset}`;
    if (rows.length === 0) return [];
    const albumIds = rows.map((r) => r.album_id);
    const releaseIds = [...new Set(rows.map((r) => r.release_id).filter((x): x is string => x !== null))];
    const evidence = await sql<Array<{ id: string; tracks: Array<{ title?: unknown; durS?: unknown }> | null }>>`
      select local_album_id::text as id, evidence->'tracks' as tracks from album_evidence where local_album_id = any(${albumIds}::uuid[])`;
    const fromEvidence = new Map(evidence.map((e) => [e.id, Array.isArray(e.tracks) ? e.tracks : null]));
    const scannedIds = albumIds.filter((id) => !fromEvidence.get(id));
    const scanned = scannedIds.length === 0 ? [] : await sql<Array<{ album_id: string; title: string | null; duration_ms: number | null }>>`
      select local_album_id::text as album_id, title_guess as title, duration_ms
        from local_tracks where local_album_id = any(${scannedIds}::uuid[])
       order by local_album_id, disc_no nulls last, track_no nulls last, id`;
    const canonical = releaseIds.length === 0 ? [] : await sql<Array<{ release_id: string; title: string | null; length_ms: number | null }>>`
      select release_id::text as release_id, title, length_ms
        from canonical_tracks where release_id = any(${releaseIds}::uuid[])
       order by release_id, medium_no nulls last, position nulls last, id`;
    const scannedBy = byKey(scanned.map((t) => ({ key: t.album_id, title: t.title, ms: t.duration_ms })));
    const canonicalBy = byKey(canonical.map((t) => ({ key: t.release_id, title: t.title, ms: t.length_ms })));
    return rows.map((r) => {
      const ev = fromEvidence.get(r.album_id);
      const albumTracks = ev
        ? ev.map((t) => ({
            title: typeof t.title === 'string' ? t.title : null,
            seconds: typeof t.durS === 'number' && t.durS > 0 ? t.durS : null,
          }))
        : (scannedBy.get(r.album_id) ?? []);
      return {
        id: r.id, band: r.band, verdict: r.verdict,
        albumId: r.album_id, albumTitle: r.title_guess, albumArtist: r.artist_guess, albumYear: r.year_guess, albumTracks,
        releaseId: r.release_id, releaseTitle: r.r_title, releaseDate: r.r_date, releaseCountry: r.country, releaseLabels: r.labels, releaseMedia: r.media,
        releaseSource: r.source_of_truth, releaseTracks: canonicalBy.get(r.release_id) ?? [],
        probability: r.probability === null ? null : Number(r.probability), groupSize: r.group_size,
      };
    });
  }, []);
}
