import type postgres from 'postgres';
import type { maintenanceTasks } from './schema.js';

type Sql = postgres.Sql;
type Tx = postgres.TransactionSql;
type Task = typeof maintenanceTasks.$inferSelect;

export interface MaintenanceRow {
  id: string;
  library_id: string;
  kind: Task['kind'];
  scope_key: string;
  subject_id: string | null;
  queue: string;
  input: Record<string, unknown>;
  state: Task['state'];
  stage: string;
  progress: Task['progress'];
  error: string | null;
  checkpoint: Task['checkpoint'];
  attempt_id: string;
  attempt: number;
  dispatched_at: Date | null;
  cancel_requested: boolean;
  updated_at: Date;
}

export interface MaintenanceWork {
  taskId: string;
  /** The pg-boss job id is also the attempt token. */
  attemptId: string;
}

export interface MaintenanceRequest {
  libraryId: string;
  kind: Task['kind'];
  scope: string;
  subjectId?: string;
  queue: string;
  input: postgres.JSONValue;
  stage: string;
}

/** Persist intent first. A retry of the request keeps the original scope and input. */
export async function saveMaintenanceTask(sql: Sql | Tx, request: MaintenanceRequest): Promise<MaintenanceRow> {
  const [row] = await sql<MaintenanceRow[]>`
    insert into maintenance_tasks (library_id, kind, scope_key, subject_id, queue, input, state, stage)
    values (${request.libraryId}, ${request.kind}, ${request.scope}, ${request.subjectId ?? null},
            ${request.queue}, ${JSON.stringify(request.input)}::text::jsonb, 'waiting', ${request.stage})
    on conflict (library_id, kind, scope_key) where state not in ('done', 'cancelled')
    do update set scope_key = excluded.scope_key
    returning *
  `;
  if (!row) throw new Error('Could not save maintenance task');
  return row;
}

export type MaintenanceSender = (tx: Tx, queue: string, id: string, data: object) => Promise<string | null>;

/** The part of pg-boss a sender needs: send() with its options, a transaction's executeSql among them. */
export interface MaintenanceJobQueue {
  send(name: string, data: object, options: Record<string, unknown>): Promise<string | null>;
}

/**
 * The pg-boss options of one attempt's job: its id and its singletonKey are
 * the attempt's own. Most maintenance queues are 'stately' (files.split,
 * tags.apply, art.fetch, files.trash, files.upgrade), which keeps one queued
 * and one active job per singletonKey. Sent without a key (0.28.0, 0.29.0),
 * every task on a queue shared the empty key: a second album's cut points
 * could not be queued while the first waited, and a job a stopped worker left
 * 'active' held every other split back until pg-boss expired it, hours later.
 * The task's scope (maintenance_tasks_open_scope) and the claim's advisory
 * lock are what keep two attempts of one task apart.
 */
export function maintenanceJobOptions(attemptId: string): { id: string; singletonKey: string; retryLimit: 0 } {
  return { id: attemptId, singletonKey: `maintenance:${attemptId}`, retryLimit: 0 };
}

/** Sends an attempt's job inside the dispatch transaction: the job exists exactly when the dispatch commits. */
export function maintenanceSender(boss: MaintenanceJobQueue): MaintenanceSender {
  return (tx, queue, id, data) => boss.send(queue, data, {
    ...maintenanceJobOptions(id),
    db: { executeSql: async (query: string, values?: unknown[]) => ({ rows: await tx.unsafe(query, values as never[] | undefined) }) },
  });
}

/** Queue insertion and dispatch acknowledgement commit together. */
export async function dispatchMaintenanceTask(sql: Sql, send: MaintenanceSender, id: string): Promise<void> {
  await sql.begin(async (tx) => {
    const [row] = await tx<MaintenanceRow[]>`
      select * from maintenance_tasks
      where id = ${id} and state = 'waiting' and dispatched_at is null and dispatch_after <= now()
      for update
    `;
    if (!row) return;
    const data = { ...row.input, maintenance: { taskId: row.id, attemptId: row.attempt_id } satisfies MaintenanceWork };
    if (await send(tx, row.queue, row.attempt_id, data) !== row.attempt_id) {
      throw new Error('Could not dispatch maintenance task');
    }
    await tx`update maintenance_tasks set dispatched_at = now() where id = ${id}`;
  });
}

export async function undispatchedMaintenanceTasks(sql: Sql): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`
    select id from maintenance_tasks
    where state = 'waiting' and dispatched_at is null and dispatch_after <= now()
    order by updated_at limit 50
  `;
  return rows.map((row) => row.id);
}

/** pg-boss expires abandoned jobs. A terminal or missing attempt cannot advance the task. */
export async function reconcileMaintenanceTasks(sql: Sql): Promise<void> {
  const [schema] = await sql<{ exists: boolean }[]>`select to_regclass('pgboss.job') is not null as exists`;
  if (!schema?.exists) return;
  await sql`
    update maintenance_tasks t
    set state = case when cancel_requested and checkpoint ? 'inFlight' then 'waiting'
                     when cancel_requested then 'cancelled' else 'interrupted' end,
        attempt_id = case when cancel_requested and checkpoint ? 'inFlight' then gen_random_uuid() else attempt_id end,
        dispatched_at = case when cancel_requested and checkpoint ? 'inFlight' then null else dispatched_at end,
        stage = case when cancel_requested and not (coalesce(checkpoint, '{}'::jsonb) ? 'inFlight') then 'Empty Trash cancelled' else stage end,
        error = case when cancel_requested then null else 'The worker stopped before this task finished.' end,
        updated_at = now()
    where t.state in ('waiting', 'running') and t.dispatched_at is not null
      and not exists (
        select 1 from pgboss.job j where j.name = t.queue and j.id = t.attempt_id
          and j.state in ('created', 'retry', 'active')
      )
  `;
  await sql`update file_deletions d set purge_task_id = null
    from maintenance_tasks t where d.purge_task_id = t.id and t.state in ('done', 'cancelled')`;

}

export async function getMaintenanceTask(sql: Sql | Tx, libraryId: string, id: string): Promise<MaintenanceRow | null> {
  const [row] = await sql<MaintenanceRow[]>`select * from maintenance_tasks where library_id = ${libraryId} and id = ${id}`;
  return row ?? null;
}

export async function latestMaintenanceTask(sql: Sql | Tx, libraryId: string, kind: Task['kind'], scope: string): Promise<MaintenanceRow | null> {
  const [row] = await sql<MaintenanceRow[]>`
    select * from maintenance_tasks where library_id = ${libraryId} and kind = ${kind} and scope_key = ${scope}
    order by created_at desc, id desc limit 1
  `;
  return row ?? null;
}

export async function listMaintenanceTasks(sql: Sql, libraryId: string): Promise<MaintenanceRow[]> {
  return await sql<MaintenanceRow[]>`
    select * from maintenance_tasks where library_id = ${libraryId} order by updated_at desc, id desc limit 50
  `;
}

/** The session advisory lock a claim holds for as long as its process runs the task. */
export function maintenanceLockKey(task: Pick<MaintenanceRow, 'library_id' | 'kind' | 'scope_key'>): string {
  return `tagave:maintenance:${JSON.stringify([task.library_id, task.kind, task.scope_key])}`;
}

/** A session lock prevents a retry from touching files while an old process still owns them. */
export async function withMaintenanceClaim<T>(sql: Sql, work: MaintenanceWork, run: (row: MaintenanceRow) => Promise<T>): Promise<T | undefined> {
  const [task] = await sql<Pick<MaintenanceRow, 'library_id' | 'kind' | 'scope_key'>[]>`
    select library_id, kind, scope_key from maintenance_tasks
    where id = ${work.taskId} and attempt_id = ${work.attemptId} and state = 'waiting'
  `;
  if (!task) return undefined;
  const key = maintenanceLockKey(task);
  const connection = await sql.reserve();
  let locked = false;
  try {
    const [lock] = await connection<{ acquired: boolean }[]>`select pg_try_advisory_lock(hashtextextended(${key}, 0)) as acquired`;
    locked = lock?.acquired === true;
    if (!locked) return undefined;
    const [row] = await connection<MaintenanceRow[]>`
      update maintenance_tasks set state = 'running', updated_at = now()
      where id = ${work.taskId} and attempt_id = ${work.attemptId}
        and state = 'waiting'
      returning *
    `;
    if (row) return await run(row);
  } finally {
    try {
      if (locked) await connection`select pg_advisory_unlock(hashtextextended(${key}, 0))`;
    } finally {
      connection.release();
    }
  }
}

export interface MaintenanceUpdate {
  state?: Task['state'];
  stage?: string;
  progress?: Task['progress'];
  error?: string | null;
  checkpoint?: object | null;
  /** A follow-up poll uses a fresh queue job without creating a user retry. */
  pollAfterMs?: number;
}

/** False means the job lost its claim and must stop before the next effect. */
export async function updateMaintenanceTask(sql: Sql | Tx, work: MaintenanceWork, patch: MaintenanceUpdate): Promise<boolean> {
  const result = await sql`
    update maintenance_tasks
    set state = case when ${patch.pollAfterMs !== undefined} then 'waiting' else coalesce(${patch.state ?? null}, state) end,
        attempt_id = case when ${patch.pollAfterMs !== undefined} then gen_random_uuid() else attempt_id end,
        dispatched_at = case when ${patch.pollAfterMs !== undefined} then null else dispatched_at end,
        dispatch_after = case when ${patch.pollAfterMs !== undefined} then now() + ${patch.pollAfterMs ?? 0}::int * interval '1 millisecond' else dispatch_after end, stage = coalesce(${patch.stage ?? null}, stage),
        progress = case when ${patch.progress !== undefined} then ${patch.progress ? JSON.stringify(patch.progress) : null}::text::jsonb else progress end,
        error = case when ${patch.error !== undefined} then ${patch.error ?? null} else error end,
        checkpoint = case when ${patch.checkpoint !== undefined} then ${patch.checkpoint != null ? JSON.stringify(patch.checkpoint) : null}::text::jsonb else checkpoint end,
        updated_at = now()
    where id = ${work.taskId} and attempt_id = ${work.attemptId} and state = 'running'
  `;
  return result.count === 1;
}

export async function currentMaintenanceClaim(sql: Sql, work: MaintenanceWork): Promise<MaintenanceRow | null> {
  const [row] = await sql<MaintenanceRow[]>`
    select * from maintenance_tasks where id = ${work.taskId} and attempt_id = ${work.attemptId} and state = 'running'
  `;
  return row ?? null;
}

export async function restartMaintenanceTask(sql: Sql | Tx, libraryId: string, id: string, attempt: number, restoreOriginal = false): Promise<MaintenanceRow | null> {
  // The observed attempt prevents two tabs from starting another try after a fast failure.
  const [row] = await sql<MaintenanceRow[]>`
    update maintenance_tasks
    set history = history || jsonb_build_array(jsonb_build_object(
          'id', attempt_id, 'state', state, 'error', error, 'at', updated_at)),
        checkpoint = case when ${restoreOriginal} then jsonb_set(checkpoint, '{restoreOriginal}', 'true'::jsonb) else checkpoint end,
        stage = case when ${restoreOriginal} then 'Restore original queued'
                     when checkpoint is null then 'Retry queued' else 'Continuation queued' end,
        state = 'waiting', attempt = attempt + 1, attempt_id = gen_random_uuid(),
        dispatched_at = null, dispatch_after = now(), error = null, updated_at = now()
    where library_id = ${libraryId} and id = ${id} and attempt = ${attempt}
      and state in ('interrupted', 'review', 'failed')
      and (not ${restoreOriginal} or (kind = 'flac-upgrade' and checkpoint->'swap'->>'phase' in ('publish', 'catalog')))
    returning *
  `;
  return row ?? null;
}

/** A queued purge can stop immediately. An active purge stops at its next file boundary. */
export async function cancelMaintenanceTask(sql: Sql, libraryId: string, id: string): Promise<MaintenanceRow | null> {
  return sql.begin(async (tx) => {
    const [row] = await tx<MaintenanceRow[]>`
      update maintenance_tasks
      set state = case when state = 'running' then state
                       when checkpoint ? 'inFlight' then 'waiting' else 'cancelled' end,
          attempt_id = case when state in ('interrupted', 'review', 'failed') and checkpoint ? 'inFlight'
                            then gen_random_uuid() else attempt_id end,
          dispatched_at = case when state in ('interrupted', 'review', 'failed') and checkpoint ? 'inFlight'
                               then null else dispatched_at end,
          stage = case when state <> 'running' and not (coalesce(checkpoint, '{}'::jsonb) ? 'inFlight') then 'Empty Trash cancelled' else stage end,
          cancel_requested = true, error = null, updated_at = now()
      where library_id = ${libraryId} and id = ${id} and kind = 'empty-trash'
        and state not in ('done', 'cancelled') and not cancel_requested
      returning *
    `;
    if (row?.state === 'cancelled') await tx`update file_deletions set purge_task_id = null where purge_task_id = ${id}`;
    return row ?? null;
  });
}

const WORKER_STOPPED = 'The worker stopped before this task finished.';
/** A job claimed this long ago whose claim nobody holds was left by a worker that stopped. */
const ABANDONED_AFTER = '15 minutes';

/** Tasks that only read (cut points, a cover lookup) run again on their own; the others wait for the owner's Continue. */
function rerunsOnItsOwn(row: Pick<MaintenanceRow, 'kind' | 'scope_key'>): boolean {
  return row.kind === 'cover' || (row.kind === 'split' && row.scope_key.endsWith(':analyze'));
}

/** Whether some session (a live worker's claim) holds the task's advisory lock. */
async function claimHeld(sql: Sql, row: Pick<MaintenanceRow, 'library_id' | 'kind' | 'scope_key'>): Promise<boolean> {
  // pg_locks shows a bigint advisory key as its high (classid) and low (objid) 32 bits, objsubid 1
  const [lock] = await sql<{ held: boolean }[]>`
    select exists (
      select 1 from pg_locks
      where locktype = 'advisory' and granted and objsubid = 1
        and database = (select oid from pg_database where datname = current_database())
        and ((classid::bigint << 32) | objid::bigint) = hashtextextended(${maintenanceLockKey(row)}, 0)
    ) as held`;
  return lock?.held === true;
}

export interface MaintenanceRecoveryOptions {
  /** Whether this worker works the queue (the file worker: files.split, art.fetch …). */
  serves(queue: string): boolean;
  send: MaintenanceSender;
  /** Cancels a job a stopped worker left 'active', so it holds no slot until pg-boss expires it. */
  cancel?(queue: string, id: string): Promise<unknown>;
}

export interface MaintenanceRecovery {
  /** read-only tasks a stopped worker left running, queued again */
  requeued: string[];
  /** tasks that write files, left for the owner's Continue */
  interrupted: string[];
  /** 0.27 split rows still finding their cut points with no job left, given an analysis task */
  legacy: string[];
}

/**
 * At worker start, before any handler claims work: a task a stopped worker
 * left behind (its job still 'active', its claim's lock held by nobody) is
 * queued again when it only reads, or interrupted for the owner when it
 * writes. pg-boss alone would keep such a job 'active' until it expires,
 * three hours for files.split. A 0.27 split row still finding its cut points
 * whose job is gone (or abandoned) gets the analysis task 0.28 would have
 * made. Each runs once: what it fixes is no longer left behind. An Empty
 * Trash being cancelled is left to reconcileMaintenanceTasks, which settles
 * a cancel once its job ends.
 */
export async function recoverMaintenanceTasks(sql: Sql, options: MaintenanceRecoveryOptions): Promise<MaintenanceRecovery> {
  const out: MaintenanceRecovery = { requeued: [], interrupted: [], legacy: [] };
  const [schema] = await sql<{ exists: boolean }[]>`select to_regclass('pgboss.job') is not null as exists`;
  if (!schema?.exists) return out;

  const left = await sql<MaintenanceRow[]>`
    select t.* from maintenance_tasks t
    where not t.cancel_requested and (t.state = 'running'
       or (t.state = 'waiting' and t.dispatched_at is not null and exists (
             select 1 from pgboss.job j where j.name = t.queue and j.id = t.attempt_id
               and j.state = 'active' and j.started_on < now() - ${ABANDONED_AFTER}::interval)))
    order by t.updated_at`;
  for (const row of left) {
    if (!options.serves(row.queue) || await claimHeld(sql, row)) continue;
    const rerun = rerunsOnItsOwn(row);
    const [next] = await sql<MaintenanceRow[]>`
      update maintenance_tasks
      set history = history || jsonb_build_array(jsonb_build_object(
            'id', attempt_id, 'state', 'interrupted', 'error', ${WORKER_STOPPED}::text, 'at', now())),
          state = ${rerun ? 'waiting' : 'interrupted'},
          stage = case when ${rerun} then 'Queued again after the worker stopped' else stage end,
          error = case when ${rerun} then null else ${WORKER_STOPPED} end,
          attempt = case when ${rerun} then attempt + 1 else attempt end,
          attempt_id = case when ${rerun} then gen_random_uuid() else attempt_id end,
          dispatched_at = case when ${rerun} then null else dispatched_at end,
          dispatch_after = case when ${rerun} then now() else dispatch_after end,
          updated_at = now()
      where id = ${row.id} and attempt_id = ${row.attempt_id} and state = ${row.state}
      returning *`;
    if (!next) continue;
    await options.cancel?.(row.queue, row.attempt_id).catch(() => undefined);
    if (rerun) {
      out.requeued.push(row.id);
      // the app's outbox sends it if this does not
      await dispatchMaintenanceTask(sql, options.send, row.id).catch(() => undefined);
    } else {
      out.interrupted.push(row.id);
    }
  }

  if (!options.serves('files.split')) return out;
  const legacy = await sql<{ id: string; library_id: string; local_album_id: string }[]>`
    select s.id::text as id, s.library_id::text as library_id, s.local_album_id::text as local_album_id
    from album_splits s
    where s.state = 'analyzing' and s.plan is null and s.local_album_id is not null
      and not exists (select 1 from maintenance_tasks t where t.library_id = s.library_id and t.kind = 'split'
                        and t.scope_key = s.id::text || ':analyze')
      and not exists (select 1 from pgboss.job j where j.name = 'files.split' and j.data->>'splitId' = s.id::text
                        and j.data->>'action' = 'analyze' and not (j.data ? 'maintenance')
                        and (j.state in ('created', 'retry') or (j.state = 'active' and j.started_on >= now() - ${ABANDONED_AFTER}::interval)))
    order by s.created_at`;
  for (const split of legacy) {
    const taskId = await sql.begin(async (tx) => {
      // the lock the app's Split takes (planSplits › requestSplitAnalysis): one task for the row either way
      await tx`select pg_advisory_xact_lock(hashtextextended(${`tagave:split:${split.library_id}:${split.local_album_id}`}, 0))`;
      const [still] = await tx`select 1 from album_splits where id = ${split.id} and state = 'analyzing' and plan is null`;
      if (!still) return null;
      const abandoned = await tx<{ id: string }[]>`
        select id from pgboss.job where name = 'files.split' and data->>'splitId' = ${split.id}
          and data->>'action' = 'analyze' and not (data ? 'maintenance') and state = 'active'`;
      const task = await saveMaintenanceTask(tx, {
        libraryId: split.library_id, kind: 'split', scope: `${split.id}:analyze`, subjectId: split.local_album_id,
        queue: 'files.split', input: { splitId: split.id, action: 'analyze' }, stage: 'Cut point analysis queued',
      });
      return { task: task.id, abandoned: abandoned.map((j) => j.id) };
    });
    if (!taskId) continue;
    for (const id of taskId.abandoned) await options.cancel?.('files.split', id).catch(() => undefined);
    out.legacy.push(split.id);
    await dispatchMaintenanceTask(sql, options.send, taskId.task).catch(() => undefined);
  }
  return out;
}
