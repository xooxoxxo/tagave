/**
 * `liner-doctor restore <file>`: put a dump back into the configured database.
 *
 * Two ways, both refuse to run while the app or a worker is connected
 * (unless --force), and both leave a way back:
 *
 *   swap (default)  restore into a new database next to the current one,
 *                   check it, then rename: the current database becomes
 *                   <name>_pre_restore_<time> and the restored one takes its
 *                   name. Needs a database user that may create databases
 *                   (the bundled Postgres user can).
 *   in-place        take a pre-restore dump into the backups folder, empty
 *                   the database and restore into it in one transaction. If
 *                   that fails, the pre-restore dump is put back.
 *
 * Migrations are not run here: the app applies any the dump is missing when
 * it starts, and rolling back an update means starting the older version on
 * the restored data.
 */
import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { promisify } from 'node:util';
import postgres from 'postgres';
import { describeExecError, pgRestoreBin, runBackup, verifyDump } from './backup.js';

const run = promisify(execFile);

/** Workers that reported within this window count as live (matches the doctor). */
const LIVE_WINDOW_SECONDS = 120;

export type RestoreMode = 'swap' | 'in-place';

export interface ActivityReport {
  /** Other sessions connected to the target database. */
  connections: Array<{ pid: number; application: string; client: string | null; since: string | null }>;
  /** Workers with a heartbeat in the last two minutes. */
  liveWorkers: string[];
}

export class RestoreRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RestoreRefused';
  }
}

export interface RestoreOptions {
  databaseUrl: string;
  file: string;
  mode: RestoreMode;
  /** Restore even though the app or workers are connected; their sessions are closed. */
  force?: boolean;
  /** Where the in-place pre-restore dump goes. */
  backupDir: string;
  now?: Date;
  pgRestore?: string;
  pgDump?: string;
  log?: (line: string) => void;
}

export interface RestoreResult {
  mode: RestoreMode;
  database: string;
  /** swap: the database the restore replaced, kept under this name. */
  previousDatabase: string | null;
  /** in-place: the dump taken before the restore. */
  preRestoreBackup: string | null;
  tocEntries: number;
  migrationsInDump: number | null;
  latestMigration: string | null;
  durationMs: number;
}

/** Database name from a postgres:// URL. */
export function databaseName(databaseUrl: string): string {
  const name = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, ''));
  if (!name) throw new Error('DATABASE_URL names no database');
  return name;
}

/** The same server and credentials, another database. */
export function withDatabase(databaseUrl: string, name: string): string {
  const u = new URL(databaseUrl);
  u.pathname = `/${encodeURIComponent(name)}`;
  return u.toString();
}

/** 20260929T030000 — for database names (lower case, no separators Postgres would need quoting for beyond the underscore). */
export function stamp(now: Date): string {
  return now.toISOString().replace(/\.\d{3}Z$/, '').replace(/[-:]/g, '').toLowerCase();
}

/** A new database name within Postgres's 63-byte limit. */
export function sideName(base: string, suffix: string): string {
  const tail = `_${suffix}`;
  return `${base.slice(0, 63 - tail.length)}${tail}`;
}

function ident(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Who else is using the database right now. */
export async function checkActivity(databaseUrl: string): Promise<ActivityReport> {
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  try {
    const rows = await sql<Array<{ pid: number; application_name: string | null; client_addr: string | null; backend_start: Date | null }>>`
      select pid, application_name, client_addr::text as client_addr, backend_start
      from pg_stat_activity
      where datname = current_database() and pid <> pg_backend_pid() and backend_type = 'client backend'`;
    let liveWorkers: string[] = [];
    const t = await sql`select to_regclass('public.worker_heartbeats') as t`;
    if (t[0]?.['t']) {
      const hb = await sql<Array<{ worker_id: string }>>`
        select worker_id from worker_heartbeats
        where seen_at > now() - make_interval(secs => ${LIVE_WINDOW_SECONDS}) order by worker_id`;
      liveWorkers = hb.map((r) => r.worker_id);
    }
    return {
      connections: rows.map((r) => ({
        pid: r.pid,
        application: r.application_name || 'unknown',
        client: r.client_addr,
        since: r.backend_start ? new Date(r.backend_start).toISOString() : null,
      })),
      liveWorkers,
    };
  } finally {
    await sql.end({ timeout: 2 });
  }
}

/** Plain explanation of why a restore will not start, or null when it may. */
export function refusalFor(activity: ActivityReport): string | null {
  if (activity.connections.length === 0 && activity.liveWorkers.length === 0) return null;
  const parts: string[] = [];
  if (activity.liveWorkers.length > 0) parts.push(`${activity.liveWorkers.length} worker(s) checked in during the last two minutes`);
  if (activity.connections.length > 0) parts.push(`${activity.connections.length} other connection(s) are open to the database`);
  return (
    `The app or its workers still look like they are running: ${parts.join(' and ')}. ` +
    'Stop the app and both workers first (docker compose stop app worker-files worker-identify), ' +
    'then run the restore from a one-off container. Add --force to close those connections and restore anyway.'
  );
}

async function terminateOthers(sql: postgres.Sql, database: string): Promise<void> {
  await sql`select pg_terminate_backend(pid) from pg_stat_activity where datname = ${database} and pid <> pg_backend_pid()`;
}

async function restoreInto(url: string, file: string, pgRestore: string | undefined, singleTransaction: boolean): Promise<void> {
  const args = ['--no-owner', '--no-privileges', '--exit-on-error', '--no-password', `--dbname=${url}`];
  if (singleTransaction) args.push('--single-transaction');
  args.push(file);
  try {
    await run(pgRestoreBin(pgRestore), args, { maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    throw new Error(describeExecError(err, 'pg_restore'));
  }
}

async function ledgerOf(url: string): Promise<{ count: number | null; latest: string | null }> {
  const sql = postgres(url, { max: 1, onnotice: () => undefined });
  try {
    const t = await sql`select to_regclass('public._migrations') as t`;
    if (!t[0]?.['t']) return { count: null, latest: null };
    const rows = await sql<Array<{ count: number; latest: string | null }>>`select count(*)::int as count, max(name) as latest from _migrations`;
    return { count: rows[0]?.count ?? 0, latest: rows[0]?.latest ?? null };
  } finally {
    await sql.end({ timeout: 2 });
  }
}

/** Drop every user schema (public, pgboss, …) and recreate an empty public. */
async function emptyDatabase(url: string): Promise<void> {
  const sql = postgres(url, { max: 1, onnotice: () => undefined });
  try {
    await sql.begin(async (tx) => {
      const schemas = await tx<Array<{ nspname: string }>>`
        select nspname from pg_namespace
        where nspname not in ('pg_catalog', 'information_schema')
          and left(nspname, 8) <> 'pg_toast' and left(nspname, 7) <> 'pg_temp'`;
      for (const s of schemas) await tx.unsafe(`drop schema ${ident(s.nspname)} cascade`);
      await tx.unsafe('create schema public');
    });
  } finally {
    await sql.end({ timeout: 2 });
  }
}

export async function runRestore(opts: RestoreOptions): Promise<RestoreResult> {
  const started = Date.now();
  const log = opts.log ?? (() => undefined);
  const now = opts.now ?? new Date();
  const target = databaseName(opts.databaseUrl);

  try {
    await access(opts.file);
  } catch {
    throw new Error(`backup file not found: ${opts.file}`);
  }
  log(`checking ${opts.file}`);
  const tocEntries = await verifyDump(opts.file, opts.pgRestore);

  const activity = await checkActivity(opts.databaseUrl);
  const refusal = refusalFor(activity);
  if (refusal && !opts.force) throw new RestoreRefused(refusal);
  if (refusal) log('--force: closing the other connections to the database');

  if (opts.mode === 'swap') {
    const fresh = sideName(target, `restore_${stamp(now)}`);
    const previous = sideName(target, `pre_restore_${stamp(now)}`);
    const admin = postgres(withDatabase(opts.databaseUrl, 'postgres'), { max: 1, onnotice: () => undefined });
    try {
      log(`creating database ${fresh}`);
      try {
        await admin.unsafe(`create database ${ident(fresh)}`);
      } catch (err) {
        const msg = (err as Error).message;
        if (/permission denied/i.test(msg)) {
          throw new Error(`this database user may not create databases (${msg}); run the restore with --in-place instead`);
        }
        throw err;
      }
      const freshUrl = withDatabase(opts.databaseUrl, fresh);
      try {
        log(`restoring into ${fresh}`);
        await restoreInto(freshUrl, opts.file, opts.pgRestore, false);
      } catch (err) {
        await admin.unsafe(`drop database if exists ${ident(fresh)}`).catch(() => undefined);
        throw err;
      }
      const ledger = await ledgerOf(freshUrl);

      log(`swapping: ${target} → ${previous}, ${fresh} → ${target}`);
      await terminateOthers(admin, target);
      await admin.unsafe(`alter database ${ident(target)} rename to ${ident(previous)}`);
      try {
        await terminateOthers(admin, fresh);
        await admin.unsafe(`alter database ${ident(fresh)} rename to ${ident(target)}`);
      } catch (err) {
        await admin.unsafe(`alter database ${ident(previous)} rename to ${ident(target)}`).catch(() => undefined);
        throw err;
      }
      return {
        mode: 'swap',
        database: target,
        previousDatabase: previous,
        preRestoreBackup: null,
        tocEntries,
        migrationsInDump: ledger.count,
        latestMigration: ledger.latest,
        durationMs: Date.now() - started,
      };
    } finally {
      await admin.end({ timeout: 2 });
    }
  }

  // in-place
  log('taking a pre-restore backup');
  const pre = await runBackup({
    databaseUrl: opts.databaseUrl,
    outDir: opts.backupDir,
    kind: 'pre-restore',
    now,
    ...(opts.pgDump ? { pgDump: opts.pgDump } : {}),
    ...(opts.pgRestore ? { pgRestore: opts.pgRestore } : {}),
  });
  log(`pre-restore backup written ${pre.path}`);

  if (refusal) {
    const admin = postgres(withDatabase(opts.databaseUrl, 'postgres'), { max: 1, onnotice: () => undefined });
    try {
      await terminateOthers(admin, target);
    } finally {
      await admin.end({ timeout: 2 });
    }
  }

  log(`emptying ${target} and restoring`);
  try {
    await emptyDatabase(opts.databaseUrl);
    await restoreInto(opts.databaseUrl, opts.file, opts.pgRestore, true);
  } catch (err) {
    log(`restore failed, putting the pre-restore backup back`);
    try {
      await emptyDatabase(opts.databaseUrl);
      await restoreInto(opts.databaseUrl, pre.path, opts.pgRestore, true);
    } catch (back) {
      throw new Error(`${(err as Error).message}; putting the pre-restore backup back failed too (${(back as Error).message}); restore ${pre.path} by hand`);
    }
    throw new Error(`${(err as Error).message}; the database is back as it was before the restore`);
  }
  const ledger = await ledgerOf(opts.databaseUrl);
  return {
    mode: 'in-place',
    database: target,
    previousDatabase: null,
    preRestoreBackup: pre.path,
    tocEntries,
    migrationsInDump: ledger.count,
    latestMigration: ledger.latest,
    durationMs: Date.now() - started,
  };
}
