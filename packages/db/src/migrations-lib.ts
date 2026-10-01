import fs from 'fs/promises';
import path from 'path';
import postgres from 'postgres';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const MIGRATIONS_DIR = path.join(__dirname, '../migrations');

/**
 * Session advisory lock held for a whole migration run, so two app starts (a
 * double `up`, a second replica, `pnpm migrate` next to a running app) cannot
 * apply the same file twice. The second start waits, then finds nothing to do.
 */
export const MIGRATION_LOCK_KEY = 7_302_026_093;

/** The migration files this build carries, sorted (the order they apply in). */
export async function listMigrationFiles(dir: string = MIGRATIONS_DIR): Promise<string[]> {
  try {
    return (await fs.readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  } catch {
    return [];
  }
}

/**
 * Compare two release versions ("0.4.1", "0.5.0-rc.2"). Returns null when
 * either is not a version (a dev build reporting "0.0.0" counts as unknown),
 * so the version rules below are skipped rather than guessed.
 */
export function compareVersions(a: string | null | undefined, b: string | null | undefined): number | null {
  const parse = (v: string | null | undefined) => {
    if (!v || v === '0.0.0') return null;
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(v.trim());
    if (!m) return null;
    return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] };
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    const d = pa.nums[i]! - pb.nums[i]!;
    if (d !== 0) return Math.sign(d);
  }
  // 1.0.0-rc.1 < 1.0.0
  if (pa.pre.length === 0 || pb.pre.length === 0) return Math.sign(pb.pre.length - pa.pre.length);
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x) ? Number(x) : null;
    const ny = /^\d+$/.test(y) ? Number(y) : null;
    if (nx !== null && ny !== null) {
      if (nx !== ny) return Math.sign(nx - ny);
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

export interface SchemaState {
  /** Files this build carries. */
  files: string[];
  /** Ledger rows, sorted. */
  applied: string[];
  /** Files this build carries that the ledger does not have yet. */
  pending: string[];
  /** Ledger rows this build does not carry. */
  unknown: string[];
  /**
   * Unknown rows that sort after this build's last file: the database was
   * migrated by a newer build. Unknown rows that sort earlier are usually a
   * file renumbered or dropped before a release and are only reported.
   */
  newer: string[];
  /** Highest app version that has migrated this database (null before the stamp existed). */
  schemaAppVersion: string | null;
  /** No ledger rows and no tables: a new install, nothing to back up. */
  fresh: boolean;
}

type Queryable = postgres.Sql | postgres.ReservedSql | postgres.TransactionSql;

async function tableExists(sql: Queryable, name: string): Promise<boolean> {
  const r = await sql`select to_regclass(${`public.${name}`}) as t`;
  return Boolean(r[0]?.['t']);
}

/** Read the ledger and the schema stamp. Works on a database that has neither table yet. */
export async function readSchemaState(sql: Queryable, files: string[]): Promise<SchemaState> {
  const hasLedger = await tableExists(sql, '_migrations');
  const applied = hasLedger
    ? (await sql`select name from _migrations order by name`).map((r) => r['name'] as string)
    : [];
  let schemaAppVersion: string | null = null;
  if (await tableExists(sql, '_schema_info')) {
    const r = await sql`select value from _schema_info where key = 'app_version'`;
    schemaAppVersion = (r[0]?.['value'] as string | undefined) ?? null;
  }
  const appliedSet = new Set(applied);
  // A database from before the ledger (0000 applied by hand) counts 0000 as applied.
  if (!appliedSet.has('0000_init.sql') && (await tableExists(sql, 'users'))) appliedSet.add('0000_init.sql');
  const fileSet = new Set(files);
  const pending = files.filter((f) => !appliedSet.has(f));
  const unknown = applied.filter((a) => !fileSet.has(a));
  const last = files[files.length - 1];
  const newer = last === undefined ? [] : unknown.filter((u) => u > last);
  const fresh = appliedSet.size === 0;
  return { files, applied, pending, unknown, newer, schemaAppVersion, fresh };
}

export type SkewVerdict =
  | { verdict: 'ok'; detail: string }
  | { verdict: 'pending'; detail: string }
  | { verdict: 'newer'; detail: string };

/**
 * What a process of version `ownVersion` carrying `state.files` may do with
 * this database. 'newer' wins over 'pending': an older build must never run
 * against a schema a newer app migrated, even if it also lacks a file.
 */
export function classifySkew(state: SchemaState, ownVersion: string | null | undefined): SkewVerdict {
  const cmp = compareVersions(state.schemaAppVersion, ownVersion);
  if (cmp !== null && cmp > 0) {
    return {
      verdict: 'newer',
      detail: `the database was migrated by tagave ${state.schemaAppVersion}, newer than this build (${ownVersion})`,
    };
  }
  if (state.newer.length > 0) {
    const list = state.newer.slice(0, 3).join(', ') + (state.newer.length > 3 ? ', ...' : '');
    return {
      verdict: 'newer',
      detail: `the database has ${state.newer.length} migration(s) this build does not know (${list}), so a newer app migrated it`,
    };
  }
  if (state.pending.length > 0) {
    const list = state.pending.slice(0, 3).join(', ') + (state.pending.length > 3 ? ', ...' : '');
    return { verdict: 'pending', detail: `${state.pending.length} migration(s) not applied yet (${list})` };
  }
  return { verdict: 'ok', detail: `schema matches (${state.files.length} migrations)` };
}

/** Raised when the database is newer than this build; the process must not start. */
export class SchemaTooNewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaTooNewError';
  }
}

/** Raised when the backup before migrating failed; nothing was migrated. */
export class PreMigrationBackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PreMigrationBackupError';
  }
}

export interface BackupRecord {
  /**
   * 'reused': an earlier attempt at this same update already took the dump
   * and then failed part way; that dump stays the rollback point and no new
   * row is recorded.
   */
  status: 'ok' | 'skipped' | 'reused';
  path: string | null;
  bytes: number | null;
  note?: string;
}

/** The newest _migration_backups row, as beforeApply sees it. */
export interface PreviousBackup {
  id: number;
  status: string;
  path: string | null;
  bytes: number | null;
  fromVersion: string | null;
  toVersion: string | null;
  pending: string[];
  createdAt: Date;
}

/**
 * Is `state` a retry of the update `previous` was taken for? True when that
 * update targeted this same version and every file it had pending is now
 * either still pending or applied (it failed part way, or before the first
 * file). A dump taken now would hold the half-migrated schema, so the earlier
 * one must stay the rollback point.
 */
export function isRetryOfUpdate(
  previous: PreviousBackup | null,
  state: SchemaState,
  appVersion: string | null | undefined,
): boolean {
  if (!previous || previous.status !== 'ok' || !previous.path) return false;
  if ((previous.toVersion ?? null) !== (appVersion ?? null)) return false;
  const was = new Set(previous.pending);
  if (!state.pending.every((f) => was.has(f))) return false;
  const applied = new Set(state.applied);
  return previous.pending.every((f) => state.pending.includes(f) || applied.has(f));
}

export interface RunMigrationsOptions {
  /** This app's version; stamped on the database after a migration so older workers refuse it. */
  appVersion?: string;
  migrationsDir?: string;
  log?: (msg: string) => void;
  /**
   * Called once, under the lock, when an existing database has pending
   * migrations, with the newest recorded backup (null when none). Throwing
   * aborts the run before anything is applied.
   */
  beforeApply?: (state: SchemaState, previous: PreviousBackup | null) => Promise<BackupRecord>;
  /** Start even though a newer app migrated the database (LINER_ALLOW_SCHEMA_SKEW). */
  allowNewerSchema?: boolean;
  /** How often to say "still waiting" while another start holds the lock. */
  lockNoticeMs?: number;
}

export interface RunMigrationsResult {
  applied: string[];
  backup: BackupRecord | null;
  waitedForLock: boolean;
  state: SchemaState;
}

const BOOTSTRAP_SQL = `
  create table if not exists _migrations (
    name text primary key,
    applied_at timestamptz not null default now()
  );
  create table if not exists _schema_info (
    key text primary key,
    value text not null,
    updated_at timestamptz not null default now()
  );
  create table if not exists _migration_backups (
    id bigserial primary key,
    created_at timestamptz not null default now(),
    status text not null,
    path text,
    bytes bigint,
    from_version text,
    to_version text,
    pending text[] not null default '{}',
    note text
  );
`;

/**
 * Apply all pending SQL migrations (idempotent, ledgered, baseline-aware).
 * Called by the migrate script AND by the api on boot (spec §15.6).
 *
 * The whole run holds MIGRATION_LOCK_KEY on one reserved connection. Under
 * the lock: refuse a database a newer app migrated, call `beforeApply` (the
 * pre-migration backup) when an existing database has pending files, apply
 * each file in its own transaction, then stamp the app version.
 */
export async function runMigrations(
  databaseUrl: string,
  opts: RunMigrationsOptions = {},
): Promise<RunMigrationsResult> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  const conn = await sql.reserve();
  let locked = false;
  let waitedForLock = false;
  try {
    const got = await conn`select pg_try_advisory_lock(${MIGRATION_LOCK_KEY}::bigint) as ok`;
    if (!got[0]?.['ok']) {
      waitedForLock = true;
      log('another tagave process is migrating the database; waiting for it to finish');
      const every = opts.lockNoticeMs ?? 30_000;
      const notice = setInterval(() => log('still waiting for the other migration run to finish'), every);
      try {
        await conn`select pg_advisory_lock(${MIGRATION_LOCK_KEY}::bigint)`;
      } finally {
        clearInterval(notice);
      }
    }
    locked = true;

    await conn.unsafe(BOOTSTRAP_SQL);
    const files = await listMigrationFiles(opts.migrationsDir);
    let state = await readSchemaState(conn, files);

    // Baseline: a database whose 0000 was applied before the ledger existed.
    if (!state.applied.includes('0000_init.sql') && !state.pending.includes('0000_init.sql') && files.includes('0000_init.sql')) {
      await conn`insert into _migrations (name) values ('0000_init.sql') on conflict do nothing`;
      state = await readSchemaState(conn, files);
    }

    const cmp = compareVersions(state.schemaAppVersion, opts.appVersion);
    if (cmp !== null && cmp > 0 && !opts.allowNewerSchema) {
      throw new SchemaTooNewError(
        `This app is tagave ${opts.appVersion}, but the database was last migrated by tagave ${state.schemaAppVersion}. ` +
          'An older app must not run on a newer database. Update this app to that version or newer, or restore the ' +
          'backup taken before that update. Set LINER_ALLOW_SCHEMA_SKEW=1 to start anyway.',
      );
    }
    if (state.newer.length > 0) {
      log(`warning: the database has migrations this build does not carry: ${state.newer.join(', ')}`);
    }

    let backup: BackupRecord | null = null;
    if (state.pending.length > 0 && !state.fresh && opts.beforeApply) {
      const rows = await conn`
        select id, status, path, bytes, from_version, to_version, pending, created_at
        from _migration_backups order by id desc limit 1`;
      const r = rows[0];
      const previous: PreviousBackup | null = r
        ? {
            id: Number(r['id']),
            status: r['status'] as string,
            path: (r['path'] as string | null) ?? null,
            bytes: r['bytes'] === null || r['bytes'] === undefined ? null : Number(r['bytes']),
            fromVersion: (r['from_version'] as string | null) ?? null,
            toVersion: (r['to_version'] as string | null) ?? null,
            pending: (r['pending'] as string[] | null) ?? [],
            createdAt: r['created_at'] as Date,
          }
        : null;
      backup = await opts.beforeApply(state, previous);
      if (backup.status !== 'reused') {
        await conn`
          insert into _migration_backups (status, path, bytes, from_version, to_version, pending, note)
          values (${backup.status}, ${backup.path}, ${backup.bytes}, ${state.schemaAppVersion},
                  ${opts.appVersion ?? null}, ${state.pending}, ${backup.note ?? null})`;
      }
    }

    const applied: string[] = [];
    for (const file of state.pending) {
      const body = await fs.readFile(path.join(opts.migrationsDir ?? MIGRATIONS_DIR, file), 'utf-8');
      log(`applying ${file}...`);
      // One transaction per file, on the connection that holds the lock
      // (a reserved connection has no .begin()).
      await conn`begin`;
      try {
        await conn.unsafe(body);
        await conn`insert into _migrations (name) values (${file})`;
        await conn`commit`;
      } catch (err) {
        await conn`rollback`.catch(() => undefined);
        throw err;
      }
      applied.push(file);
    }

    // Stamp the version that migrated (never lowered): older workers then refuse.
    // The first boot of a build that has the stamp initialises it.
    const isRelease = compareVersions(opts.appVersion, opts.appVersion) !== null; // not "0.0.0" or garbage
    const raises = compareVersions(opts.appVersion, state.schemaAppVersion) === 1;
    const shouldStamp =
      opts.appVersion !== undefined && isRelease && (state.schemaAppVersion === null || (applied.length > 0 && raises));
    if (shouldStamp) {
      await conn`
        insert into _schema_info (key, value) values ('app_version', ${opts.appVersion!})
        on conflict (key) do update set value = excluded.value, updated_at = now()`;
    }

    return { applied, backup, waitedForLock, state: await readSchemaState(conn, files) };
  } finally {
    if (locked) {
      await conn`select pg_advisory_unlock(${MIGRATION_LOCK_KEY}::bigint)`.catch(() => undefined);
    }
    conn.release();
    await sql.end({ timeout: 5 });
  }
}
