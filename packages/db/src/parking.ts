/**
 * Parked work (0097 parked_jobs, vault "tagave - Offline Library Spec",
 * section 4 "Job queue behaviour: wait, never fail"): a job that met an
 * offline music folder waits here, one row per root, queue and singleton key,
 * and is sent again when the folder watch reads the folder online. A parked
 * maintenance task is a row with `queue = 'maintenance'` and `data.taskId`:
 * the task row itself holds the work (state 'waiting', dispatch_after
 * 'infinity'), and the return only lets it be dispatched again.
 */
import type postgres from 'postgres';
import { releaseMaintenanceTask, transactionDb, type MaintenanceJobQueue } from './maintenance.js';
import { ROOT_REACH_REASONS, ROOT_REACH_VALUES, type RootReach, type RootReachReason } from './musicFolder.js';

type Q = postgres.Sql<any> | postgres.TransactionSql<any>;
type Tx = postgres.TransactionSql;

/** The queue name of a parked maintenance task's row. */
export const PARKED_MAINTENANCE_QUEUE = 'maintenance';

export async function parkJob(
  sql: Q,
  p: { scanRootId: string; queue: string; data: object; singletonKey: string | null; reason: RootReachReason },
): Promise<void> {
  await sql`
    insert into parked_jobs (scan_root_id, queue, data, singleton_key, reason)
    values (${p.scanRootId}, ${p.queue}, ${JSON.stringify(p.data)}::text::jsonb, ${p.singletonKey}, ${p.reason})
    on conflict (scan_root_id, queue, singleton_key) where singleton_key is not null do nothing`;
}

/** Sends one parked job inside the release's transaction (pg-boss `send` over `tx`). */
export type ParkedSender = (tx: Tx, queue: string, data: object, singletonKey: string | null) => Promise<void>;

/**
 * The release's sender, as maintenanceSender sends an attempt: pg-boss `send`
 * over the transaction, the job's singleton key kept. A send pg-boss drops as
 * a duplicate (null: one is queued with that key already) is no failure.
 */
export function parkedSender(boss: MaintenanceJobQueue): ParkedSender {
  return async (tx, queue, data, singletonKey) => {
    await boss.send(queue, data, { ...(singletonKey !== null ? { singletonKey } : {}), db: transactionDb(tx) });
  };
}

/** The scan queues the return's own scan of the root covers (ruling R14). */
export const COVERED_SCAN_QUEUES: readonly string[] = ['scan.root', 'scan.dir'];

export interface ReleaseOptions {
  /** Only rows parked before this (a reading's start, database clock): a job that parks during the reading stays. */
  before?: Date | undefined;
  /**
   * The return sends a scan of the root itself: parked scan.root and scan.dir
   * rows are deleted, not sent. `fullScan` comes back true when one of the
   * deleted scan.root rows asked for a full scan.
   */
  coverScans?: boolean | undefined;
  /** Each released maintenance task, after the commit (the caller dispatches it). */
  onTask?: (taskId: string) => void;
}

export interface Released {
  /** rows released: sent, covered by the return's scan, or tasks let go */
  count: number;
  /** a covered scan.root row asked for mode 'full' */
  fullScan: boolean;
}

/**
 * Sends the root's parked jobs again and deletes the rows, in one
 * transaction with the sends: a send that throws rolls back and leaves every
 * row. A maintenance row lets its task be dispatched again
 * (releaseMaintenanceTask). The delete takes the rows first, so a release
 * running beside this one waits and then finds none.
 */
export async function releaseParked(sql: postgres.Sql, rootId: string, send: ParkedSender, opts: ReleaseOptions = {}): Promise<number> {
  return (await releaseParkedRows(sql, rootId, send, opts)).count;
}

export async function releaseParkedRows(sql: postgres.Sql, rootId: string, send: ParkedSender, opts: ReleaseOptions = {}): Promise<Released> {
  const before = opts.before?.toISOString() ?? null;
  // the usual answer (nothing parked) without a transaction
  const [any] = await sql<{ any: boolean }[]>`
    select exists (select 1 from parked_jobs where scan_root_id = ${rootId}
                     and (${before}::timestamptz is null or parked_at < ${before}::timestamptz)) as any`;
  if (!any?.any) return { count: 0, fullScan: false };
  const tasks: string[] = [];
  const out = await sql.begin(async (tx) => {
    const rows = await tx<{ queue: string; data: Record<string, unknown>; singleton_key: string | null }[]>`
      with gone as (
        delete from parked_jobs
        where scan_root_id = ${rootId} and (${before}::timestamptz is null or parked_at < ${before}::timestamptz)
        returning *)
      select queue, data, singleton_key from gone order by parked_at, id`;
    let fullScan = false;
    for (const row of rows) {
      if (row.queue === PARKED_MAINTENANCE_QUEUE) {
        const taskId = typeof row.data.taskId === 'string' ? row.data.taskId : null;
        if (!taskId) continue; // a malformed row: nothing to release, deleted with the rest
        await releaseMaintenanceTask(tx, taskId);
        tasks.push(taskId);
      } else if (opts.coverScans && COVERED_SCAN_QUEUES.includes(row.queue)) {
        if (row.queue === 'scan.root' && row.data.mode === 'full') fullScan = true;
      } else {
        await send(tx, row.queue, row.data, row.singleton_key);
      }
    }
    return { count: rows.length, fullScan };
  });
  if (opts.onTask) for (const id of tasks) opts.onTask(id);
  return out;
}

/** The database's clock now: the start of a reading, to compare with parked_at. */
export async function databaseNow(sql: Q): Promise<Date> {
  const [row] = await sql<{ ms: number }[]>`select (extract(epoch from clock_timestamp()) * 1000)::float8 as ms`;
  return new Date(row!.ms);
}

/** What the folder watch last read on a root: reach and its reason. */
export interface Reach {
  reach: RootReach;
  reason: RootReachReason | null;
}

/** One indexed read (the primary key). A root that is gone reads 'unknown'. */
export async function rootReach(sql: Q, rootId: string): Promise<Reach> {
  const [row] = await sql<{ reach: string; reason: string | null }[]>`
    select reach, reach_reason as reason from scan_roots where id = ${rootId}`;
  if (!row) return { reach: 'unknown', reason: null };
  const reach = (ROOT_REACH_VALUES as readonly string[]).includes(row.reach) ? (row.reach as RootReach) : 'unknown';
  const reason = (ROOT_REACH_REASONS as readonly unknown[]).includes(row.reason) ? (row.reason as RootReachReason) : null;
  return { reach, reason };
}
