/**
 * How often the decider agrees with the owner, per band. It only informs the
 * owner: nothing reads it to accept, gate or undo anything.
 *
 *   backtest  a backtest run's decisions against what the owner decided
 *             before: a live match the owner made, or the album kept as is
 *   queue     the owner's review-queue decisions made after the latest
 *             decision of one of the library's needs_review runs on the
 *             album (a read of the matches, nothing hooks the queue)
 *
 * A pick agrees when the owner accepted a release of its tracklist group,
 * and disagrees with another release or with the album kept as is. A none
 * agrees with the album kept as is; beside a release the owner accepted it
 * made no decision. Any other outcome (too large, no candidates, rejected,
 * an error) made no decision either. Picks count in their band, everything
 * else in 'none'.
 *
 * The module's tables may be missing (its migration never ran): the reads
 * then answer as for empty tables.
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

/** One band's agreement: `decided` = agree + disagree + noDecision. */
export interface AgreementRow { band: string | 'none'; decided: number; agree: number; disagree: number; noDecision: number }

/** The bands from the most to the least sure; any other band follows, then 'none'. */
const BAND_ORDER = ['p99', 'p97', 'p95', 'p90'];

type Raw = { band: string; decided: number; agree: number; disagree: number; no_decision: number };

const rowsOf = (raw: Raw[]): AgreementRow[] =>
  raw.map((r) => ({ band: r.band, decided: r.decided, agree: r.agree, disagree: r.disagree, noDecision: r.no_decision }));

/**
 * The verdict per band of `compared` (a subquery of decisions with
 * outcome, band, group_release_ids, owner_release: the release the owner
 * accepted, or null when they kept the album as is).
 */
function tally(sql: Sql, compared: postgres.PendingQuery<any>) {
  return sql<Raw[]>`
    with c as (${compared}),
    v as (
      select case when c.outcome = 'pick' then coalesce(c.band, 'none') else 'none' end as band,
             case
               when c.outcome = 'pick' and c.owner_release is not null and c.owner_release = any(c.group_release_ids) then 'agree'
               when c.outcome = 'pick' then 'disagree'
               when c.outcome = 'none' and c.owner_release is null then 'agree'
               else 'no_decision'
             end as verdict
        from c)
    select band, count(*)::int as decided,
           (count(*) filter (where verdict = 'agree'))::int as agree,
           (count(*) filter (where verdict = 'disagree'))::int as disagree,
           (count(*) filter (where verdict = 'no_decision'))::int as no_decision
      from v
     group by band
     order by (band = 'none'), array_position(${BAND_ORDER}::text[], band::text) nulls last, band`;
}

/** A backtest run's decisions against the owner's own: a live match they made, or the album kept as is. */
export async function backtestAgreement(sql: Sql, runId: string): Promise<AgreementRow[]> {
  return orMissing(async () => rowsOf(await tally(sql, sql`
    select d.outcome, d.band, d.group_release_ids, am.release_id as owner_release
      from decider_decisions d
      join local_albums la on la.id = d.local_album_id
      left join album_matches am on am.local_album_id = d.local_album_id
            and am.status in ('auto', 'confirmed') and am.decided_kind = 'user'
     where d.run_id = ${runId}
       and (am.id is not null or la.state = 'as_is')`)), []);
}

/**
 * The owner's review-queue decisions made after the latest decision on the
 * album among the library's needs_review runs: a live match they made after
 * it, or the album kept as is since (it was in the review queue when it was
 * decided, so kept as is now means kept as is after).
 */
export async function queueAgreement(sql: Sql, libraryId: string): Promise<AgreementRow[]> {
  return orMissing(async () => rowsOf(await tally(sql, sql`
    select d.outcome, d.band, d.group_release_ids, am.release_id as owner_release
      from (select distinct on (dd.local_album_id) dd.local_album_id, dd.outcome, dd.band, dd.group_release_ids, dd.created_at
              from decider_decisions dd
              join decider_runs r on r.id = dd.run_id
             where r.library_id = ${libraryId} and r.population = 'needs_review'
             order by dd.local_album_id, dd.created_at desc, dd.id desc) d
      join local_albums la on la.id = d.local_album_id
      left join album_matches am on am.local_album_id = d.local_album_id
            and am.status in ('auto', 'confirmed') and am.decided_kind = 'user' and am.created_at > d.created_at
     where am.id is not null
        or (la.state = 'as_is' and la.updated_at > d.created_at
            and not exists (select 1 from album_matches lm where lm.local_album_id = d.local_album_id and lm.status in ('auto', 'confirmed')))`)), []);
}

/** The library's latest backtest run that ended done; null when there is none. */
export async function latestBacktestRunId(sql: Sql, libraryId: string): Promise<string | null> {
  return orMissing(async () => {
    const [row] = await sql<Array<{ id: string }>>`
      select id::text as id from decider_runs
       where library_id = ${libraryId} and population = 'backtest' and state = 'done'
       order by finished_at desc nulls last, created_at desc, id desc
       limit 1`;
    return row?.id ?? null;
  }, null);
}
