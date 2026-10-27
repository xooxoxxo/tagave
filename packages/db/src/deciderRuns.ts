/**
 * Decider runs left behind: a run whose job died with its worker (the job
 * expired after its last retry, or the worker was stopped) stays 'running'
 * with nothing working it. Such a run is paused as 'stopped', so the owner
 * can resume it where it stopped.
 */
import type postgres from 'postgres';

type Sql = postgres.Sql<any> | postgres.TransactionSql<any>;

/** pg-boss expiry of one decider.run job. */
export const DECIDER_RUN_EXPIRE_SECONDS = 6 * 3600;

/** The singleton key every decider.run job of a library is sent with: one run per library at a time. */
export function deciderRunSingletonKey(libraryId: string): string {
  return `decider.run:${libraryId}`;
}

/** What sends a job: pg-boss, or a stand-in in tests. */
export interface DeciderRunSender { send(name: string, data: object, opts: { singletonKey: string }): Promise<string | null> }

/**
 * Queue `runId`'s job with the library's singleton key, never a key of its
 * own: one run per library at a time. Null when pg-boss kept a job already
 * queued for the library instead (see deciderRunJobWaiting).
 */
export async function sendDeciderRun(boss: DeciderRunSender, libraryId: string, runId: string): Promise<string | null> {
  return boss.send('decider.run', { runId }, { singletonKey: deciderRunSingletonKey(libraryId) });
}

const missingOk = async <T>(read: () => Promise<T>, fallback: T): Promise<T> => {
  try {
    return await read();
  } catch (err) {
    // no pg-boss (or no module tables) in this database: no job waits
    if ((err as { code?: string }).code === '42P01') return fallback;
    throw err;
  }
};

/**
 * Whether `runId`'s own decider.run job waits (queued or to retry) for the
 * library. A send that pg-boss swallowed is fine only then.
 */
export async function deciderRunJobWaiting(sql: Sql, libraryId: string, runId: string): Promise<boolean> {
  return missingOk(async () => {
    const [row] = await sql<Array<{ waiting: boolean }>>`
      select exists (
        select 1 from pgboss.job
         where name = 'decider.run' and singleton_key = ${deciderRunSingletonKey(libraryId)}
           and state::text in ('created', 'retry') and data->>'runId' = ${runId}) as waiting`;
    return row?.waiting === true;
  }, false);
}

/**
 * Waiting decider.run jobs of the library whose run can no longer go on
 * (cancelled, ended, or gone): they hold the library's one waiting slot
 * for nothing. Their job ids.
 */
export async function staleDeciderRunJobs(sql: Sql, libraryId: string): Promise<string[]> {
  return missingOk(async () => {
    const rows = await sql<Array<{ id: string }>>`
      select j.id::text as id from pgboss.job j
       where j.name = 'decider.run' and j.singleton_key = ${deciderRunSingletonKey(libraryId)} and j.state::text in ('created', 'retry')
         and not exists (select 1 from decider_runs r
                          where r.id::text = j.data->>'runId' and r.state in ('queued', 'running', 'paused'))`;
    return rows.map((r) => r.id);
  }, []);
}

/** The ids of `runId`'s decider.run jobs that wait (queued or to retry). */
export async function waitingDeciderRunJobs(sql: Sql, runId: string): Promise<string[]> {
  return missingOk(async () => {
    const rows = await sql<Array<{ id: string }>>`
      select id::text as id from pgboss.job
       where name = 'decider.run' and data->>'runId' = ${runId} and state::text in ('created', 'retry')`;
    return rows.map((r) => r.id);
  }, []);
}

/**
 * Pause every run still 'running' with no decider.run job created, waiting
 * to retry or active for its library, and nothing done (started, a call, a
 * decision) for `olderThanSeconds` (default: the job's expiry). One
 * statement, so a job that starts meanwhile is either seen or finds the run
 * paused (a paused run resumes when its job starts). Returns the runs
 * paused. A database without the module's tables or pg-boss's has none.
 */
export async function pauseStaleRuns(sql: Sql, opts: { libraryId?: string; olderThanSeconds?: number } = {}): Promise<string[]> {
  const seconds = opts.olderThanSeconds ?? DECIDER_RUN_EXPIRE_SECONDS;
  const lib = opts.libraryId ?? null;
  try {
    const rows = await sql<Array<{ id: string }>>`
      update decider_runs r
         set state = 'paused', pause_reason = 'stopped', message = 'stopped: no progress'
       where r.state = 'running'
         and (${lib}::uuid is null or r.library_id = ${lib}::uuid)
         and greatest(r.created_at, r.started_at,
                      (select max(d.created_at) from decider_decisions d where d.run_id = r.id),
                      (select max(c.created_at) from decider_calls c where c.run_id = r.id))
             < now() - make_interval(secs => ${seconds}::int)
         and not exists (
               select 1 from pgboss.job j
                where j.name = 'decider.run' and j.singleton_key = 'decider.run:' || r.library_id::text
                  and j.state::text in ('created', 'retry', 'active'))
      returning r.id`;
    return rows.map((r) => r.id);
  } catch (err) {
    if ((err as { code?: string }).code === '42P01') return [];
    throw err;
  }
}
