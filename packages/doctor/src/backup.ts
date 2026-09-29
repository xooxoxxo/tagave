import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export const BACKUP_PREFIX = 'liner-';
export const BACKUP_SUFFIX = '.pgdump';
/** Written next to each dump by runBackup: what kind it is and whether pg_restore could read it back. */
export const SIDECAR_SUFFIX = '.json';

/**
 * Why a dump exists. nightly: the scheduled job (the only kind retention
 * deletes). manual: "Back up now" or `liner-doctor backup`. pre-migration:
 * taken by the app before it changes the database for a new version.
 * pre-restore: taken by `liner-doctor restore --in-place` before it replaces
 * the data.
 */
export const BACKUP_KINDS = ['nightly', 'manual', 'pre-migration', 'pre-restore'] as const;
export type BackupKind = (typeof BACKUP_KINDS)[number];

/**
 * liner-2026-09-08T00-30-00Z-nightly.pgdump — sorts chronologically; no colons
 * so SMB/Windows shares accept it. The kind suffix is left off for manual
 * dumps, which keeps the name older releases wrote.
 */
export function backupFileName(now: Date, kind: BackupKind = 'manual'): string {
  const ts = now.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');
  return `${BACKUP_PREFIX}${ts}${kind === 'manual' ? '' : `-${kind}`}${BACKUP_SUFFIX}`;
}

const NAME_RE = /^liner-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z(?:-([a-z-]+))?\.pgdump$/;

/**
 * Kind and time from a dump's file name. Any other *.pgdump in the directory
 * (a dump copied in by hand, or one named by an older pre-migration step) is
 * still a backup: its kind is guessed from the name and its time is null
 * (the caller falls back to the file's modification time).
 */
export function parseBackupName(name: string): { kind: BackupKind; createdAt: Date | null } | null {
  if (!name.endsWith(BACKUP_SUFFIX) || !isSafeBackupName(name)) return null;
  const m = NAME_RE.exec(name);
  if (m) {
    const kind = (BACKUP_KINDS as readonly string[]).includes(m[5] ?? '') ? (m[5] as BackupKind) : guessKind(name);
    return { kind, createdAt: new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`) };
  }
  return { kind: guessKind(name), createdAt: null };
}

function guessKind(name: string): BackupKind {
  if (/pre-?migrat/i.test(name)) return 'pre-migration';
  if (/pre-?restore/i.test(name)) return 'pre-restore';
  if (/nightly/i.test(name)) return 'nightly';
  return 'manual';
}

/** A bare file name we are willing to serve or delete: no path parts, no hidden files. */
export function isSafeBackupName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 200 &&
    name === basename(name) &&
    !name.startsWith('.') &&
    /^[A-Za-z0-9._-]+$/.test(name) &&
    name.endsWith(BACKUP_SUFFIX)
  );
}

/** Our dump files among `files`, oldest first. Foreign files in the directory are never touched. */
export function ownBackups(files: string[]): string[] {
  return files.filter((f) => f.startsWith(BACKUP_PREFIX) && f.endsWith(BACKUP_SUFFIX)).sort();
}

/** Files to delete so that only the newest `keep` of our dumps remain. */
export function pruneList(files: string[], keep: number): string[] {
  const ours = ownBackups(files);
  if (keep < 0) return [];
  return ours.slice(0, Math.max(0, ours.length - keep));
}

/** `pg_restore --list` prints one line per archive entry ("123; 1259 16384 TABLE public albums liner"); comment lines start with ';'. */
export function countTocEntries(listing: string): number {
  return listing.split('\n').filter((line) => /^\d+;/.test(line)).length;
}

/**
 * Where dumps go: BACKUP_DIR (the compose files mount a dedicated backups
 * volume there), LINER_BACKUP_DIR (older name), then CACHE_DIR/backups for a
 * source install, then ./backups.
 */
export function defaultBackupDir(env: NodeJS.ProcessEnv, cwd = process.cwd()): string {
  const explicit = env['BACKUP_DIR'] || env['LINER_BACKUP_DIR'];
  if (explicit) return explicit;
  const cacheDir = env['CACHE_DIR'];
  if (cacheDir) return join(cacheDir, 'backups');
  return join(cwd, 'backups');
}

export interface BackupOptions {
  databaseUrl: string;
  outDir: string;
  kind?: BackupKind;
  /** Total dumps to keep in outDir including the new one; undefined keeps everything. */
  keep?: number;
  now?: Date;
  pgDump?: string;
  pgRestore?: string;
}

export interface BackupResult {
  path: string;
  kind: BackupKind;
  bytes: number;
  tocEntries: number;
  pruned: string[];
  durationMs: number;
}

export interface BackupSidecar {
  kind: BackupKind;
  createdAt: string;
  verified: boolean;
  tocEntries: number;
  bytes: number;
}

export function describeExecError(err: unknown, binary: string): string {
  const e = err as NodeJS.ErrnoException & { stderr?: string };
  if (e.code === 'ENOENT') {
    return `${binary} not found on PATH — install postgresql-client-16 (the app image ships it) or point PG_DUMP/PG_RESTORE at the binaries`;
  }
  const stderr = (e.stderr ?? '').trim();
  return stderr ? `${binary}: ${stderr.split('\n').slice(-3).join(' | ')}` : `${binary}: ${e.message}`;
}

export function pgDumpBin(explicit?: string): string {
  return explicit ?? process.env['PG_DUMP'] ?? 'pg_dump';
}

export function pgRestoreBin(explicit?: string): string {
  return explicit ?? process.env['PG_RESTORE'] ?? 'pg_restore';
}

/** Read a dump's table of contents back; throws when pg_restore cannot, or finds nothing. */
export async function verifyDump(path: string, pgRestore?: string): Promise<number> {
  let tocEntries: number;
  try {
    const { stdout } = await run(pgRestoreBin(pgRestore), ['--list', path], { maxBuffer: 64 * 1024 * 1024 });
    tocEntries = countTocEntries(stdout);
  } catch (err) {
    throw new Error(describeExecError(err, 'pg_restore --list'));
  }
  if (tocEntries === 0) throw new Error('pg_restore --list found no entries in the dump');
  return tocEntries;
}

async function removeDump(dir: string, name: string): Promise<void> {
  await unlink(join(dir, name)).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== 'ENOENT') throw err;
  });
  await unlink(join(dir, name + SIDECAR_SUFFIX)).catch(() => undefined);
}

/**
 * pg_dump -Fc of the database, verified with pg_restore --list (a truncated or
 * empty archive fails here instead of at restore time), then prune older dumps.
 * The dump is written under a temporary name and renamed once verified, so a
 * half-written file never shows up as a backup. The partial file is removed on
 * any failure.
 */
export async function runBackup(opts: BackupOptions): Promise<BackupResult> {
  const started = Date.now();
  const kind = opts.kind ?? 'manual';
  const now = opts.now ?? new Date();
  await mkdir(opts.outDir, { recursive: true });
  const fileName = backupFileName(now, kind);
  const path = join(opts.outDir, fileName);
  const partial = join(opts.outDir, `.${fileName}.partial`);

  try {
    await run(pgDumpBin(opts.pgDump), ['--format=custom', '--no-password', `--file=${partial}`, `--dbname=${opts.databaseUrl}`], {
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (err) {
    await unlink(partial).catch(() => undefined);
    throw new Error(describeExecError(err, 'pg_dump'));
  }

  let tocEntries: number;
  try {
    tocEntries = await verifyDump(partial, opts.pgRestore);
  } catch (err) {
    await unlink(partial).catch(() => undefined);
    throw err;
  }
  const bytes = (await stat(partial)).size;
  await rename(partial, path);
  const sidecar: BackupSidecar = { kind, createdAt: now.toISOString(), verified: true, tocEntries, bytes };
  await writeFile(path + SIDECAR_SUFFIX, JSON.stringify(sidecar, null, 2) + '\n').catch(() => undefined);

  const pruned: string[] = [];
  if (opts.keep !== undefined) {
    const others = (await readdir(opts.outDir)).filter((f) => f !== fileName);
    for (const old of pruneList(others, Math.max(0, opts.keep - 1))) {
      await removeDump(opts.outDir, old);
      pruned.push(old);
    }
  }

  return { path, kind, bytes, tocEntries, pruned, durationMs: Date.now() - started };
}

export interface BackupEntry {
  name: string;
  kind: BackupKind;
  createdAt: string;
  bytes: number;
  /** true: read back with pg_restore when written. null: no record (copied in by hand, or written by an older release). */
  verified: boolean | null;
}

/** Every *.pgdump in `dir`, newest first. A missing directory is an empty list. */
export async function listBackups(dir: string): Promise<BackupEntry[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const entries: BackupEntry[] = [];
  for (const name of names) {
    const parsed = parseBackupName(name);
    if (!parsed) continue;
    let st;
    try {
      st = await stat(join(dir, name));
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    let sidecar: Partial<BackupSidecar> | null = null;
    try {
      sidecar = JSON.parse(await readFile(join(dir, name + SIDECAR_SUFFIX), 'utf8')) as Partial<BackupSidecar>;
    } catch {
      sidecar = null;
    }
    const kind = sidecar?.kind && (BACKUP_KINDS as readonly string[]).includes(sidecar.kind) ? sidecar.kind : parsed.kind;
    const createdAt = parsed.createdAt ?? (sidecar?.createdAt ? new Date(sidecar.createdAt) : st.mtime);
    entries.push({
      name,
      kind,
      createdAt: createdAt.toISOString(),
      bytes: st.size,
      verified: typeof sidecar?.verified === 'boolean' ? sidecar.verified && sidecar.bytes === st.size : null,
    });
  }
  return entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.name.localeCompare(a.name));
}

/** Delete one dump (and its record). Throws on an unsafe name; a missing file is not an error. */
export async function deleteBackup(dir: string, name: string): Promise<void> {
  if (!isSafeBackupName(name)) throw new Error(`not a backup file name: ${name}`);
  await removeDump(dir, name);
}

// ---------------------------------------------------------------------------
// Retention for nightly dumps: keep the newest dump of each of the last
// `keepDaily` days that have one, plus the newest of each of the last
// `keepWeekly` ISO weeks that have one. Other kinds are never deleted here.

export interface RetentionPolicy {
  keepDaily: number;
  keepWeekly: number;
}

/** yyyy-mm-dd of `d` in `timeZone` (the container's TZ). */
function dayKey(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** ISO week (e.g. 2026-W40) of a yyyy-mm-dd day. */
export function isoWeekKey(day: string): string {
  const [y, m, dd] = day.split('-').map((p) => parseInt(p, 10)) as [number, number, number];
  const d = new Date(Date.UTC(y, m - 1, dd));
  const dow = d.getUTCDay() || 7; // Monday=1 … Sunday=7
  d.setUTCDate(d.getUTCDate() + 4 - dow); // Thursday of this week decides the year
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** Names of nightly dumps the policy no longer keeps. */
export function retentionDeletes(
  entries: Array<{ name: string; kind: BackupKind; createdAt: string }>,
  policy: RetentionPolicy,
  timeZone = process.env['TZ'] || 'UTC',
): string[] {
  const nightly = entries
    .filter((e) => e.kind === 'nightly')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.name.localeCompare(a.name));
  const keep = new Set<string>();
  const days = new Set<string>();
  const weeks = new Set<string>();
  for (const e of nightly) {
    const day = dayKey(new Date(e.createdAt), safeZone(timeZone));
    if (!days.has(day) && days.size < policy.keepDaily) {
      days.add(day);
      keep.add(e.name);
    }
    const week = isoWeekKey(day);
    if (!weeks.has(week) && weeks.size < policy.keepWeekly) {
      weeks.add(week);
      keep.add(e.name);
    }
  }
  return nightly.filter((e) => !keep.has(e.name)).map((e) => e.name);
}

function safeZone(tz: string): string {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}

/** Apply the retention policy in `dir`; returns the names deleted. */
export async function applyRetention(dir: string, policy: RetentionPolicy, timeZone?: string): Promise<string[]> {
  const doomed = retentionDeletes(await listBackups(dir), policy, timeZone);
  for (const name of doomed) await removeDump(dir, name);
  return doomed;
}

// ---------------------------------------------------------------------------
// Schedule and retention settings live in the backups folder itself, not in
// the database: restoring an older dump must not bring back older settings,
// and the settings travel with the dumps when the folder is copied.

export const SETTINGS_FILE = 'backup-settings.json';
export const STATUS_FILE = 'backup-status.json';

export interface BackupSettings {
  /** Nightly backup on or off. */
  enabled: boolean;
  /** Hour of the day (0–23, container time zone) the nightly backup runs. */
  hour: number;
  keepDaily: number;
  keepWeekly: number;
}

export const SETTINGS_LIMITS = { keepDaily: { min: 1, max: 90 }, keepWeekly: { min: 0, max: 52 }, hour: { min: 0, max: 23 } } as const;

function envInt(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = parseInt(raw, 10);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

/** Defaults: on, 03:00, keep 7 daily and 4 weekly; BACKUP_HOUR / BACKUP_KEEP_DAILY / BACKUP_KEEP_WEEKLY / BACKUP_NIGHTLY=off change them. */
export function defaultBackupSettings(env: NodeJS.ProcessEnv = process.env): BackupSettings {
  return {
    enabled: !/^(0|false|off|no)$/i.test(env['BACKUP_NIGHTLY'] ?? ''),
    hour: envInt(env, 'BACKUP_HOUR', 3, SETTINGS_LIMITS.hour.min, SETTINGS_LIMITS.hour.max),
    keepDaily: envInt(env, 'BACKUP_KEEP_DAILY', 7, SETTINGS_LIMITS.keepDaily.min, SETTINGS_LIMITS.keepDaily.max),
    keepWeekly: envInt(env, 'BACKUP_KEEP_WEEKLY', 4, SETTINGS_LIMITS.keepWeekly.min, SETTINGS_LIMITS.keepWeekly.max),
  };
}

function clampInt(v: unknown, fallback: number, min: number, max: number): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : fallback;
}

export async function readBackupSettings(dir: string, env: NodeJS.ProcessEnv = process.env): Promise<BackupSettings> {
  const defaults = defaultBackupSettings(env);
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(await readFile(join(dir, SETTINGS_FILE), 'utf8')) as Record<string, unknown>;
  } catch {
    return defaults;
  }
  return {
    enabled: typeof raw['enabled'] === 'boolean' ? raw['enabled'] : defaults.enabled,
    hour: clampInt(raw['hour'], defaults.hour, SETTINGS_LIMITS.hour.min, SETTINGS_LIMITS.hour.max),
    keepDaily: clampInt(raw['keepDaily'], defaults.keepDaily, SETTINGS_LIMITS.keepDaily.min, SETTINGS_LIMITS.keepDaily.max),
    keepWeekly: clampInt(raw['keepWeekly'], defaults.keepWeekly, SETTINGS_LIMITS.keepWeekly.min, SETTINGS_LIMITS.keepWeekly.max),
  };
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\n');
  await rename(tmp, path);
}

export async function writeBackupSettings(dir: string, settings: BackupSettings): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeJsonAtomic(join(dir, SETTINGS_FILE), settings);
}

export interface BackupRunRecord {
  kind: BackupKind;
  startedAt: string;
  finishedAt: string;
  ok: boolean;
  file: string | null;
  error: string | null;
  pruned: string[];
}

export interface BackupStatusFile {
  lastRun: BackupRunRecord | null;
  lastNightly: BackupRunRecord | null;
}

export async function readBackupStatus(dir: string): Promise<BackupStatusFile> {
  try {
    const raw = JSON.parse(await readFile(join(dir, STATUS_FILE), 'utf8')) as Partial<BackupStatusFile>;
    return { lastRun: raw.lastRun ?? null, lastNightly: raw.lastNightly ?? null };
  } catch {
    return { lastRun: null, lastNightly: null };
  }
}

export async function recordBackupRun(dir: string, record: BackupRunRecord): Promise<void> {
  const current = await readBackupStatus(dir);
  const next: BackupStatusFile = {
    lastRun: record,
    lastNightly: record.kind === 'nightly' ? record : current.lastNightly,
  };
  await mkdir(dir, { recursive: true });
  await writeJsonAtomic(join(dir, STATUS_FILE), next);
}

/**
 * One scheduled or on-demand backup: dump + verify, prune nightly dumps by
 * the policy, and record the outcome in the status file (a failure too, so
 * the Backups page can say the last night failed and why).
 */
export async function runRecordedBackup(opts: {
  databaseUrl: string;
  dir: string;
  kind: 'nightly' | 'manual';
  policy?: RetentionPolicy;
  timeZone?: string;
  now?: Date;
}): Promise<BackupRunRecord> {
  const startedAt = new Date();
  let record: BackupRunRecord;
  try {
    const result = await runBackup({ databaseUrl: opts.databaseUrl, outDir: opts.dir, kind: opts.kind, ...(opts.now ? { now: opts.now } : {}) });
    const pruned = opts.policy ? await applyRetention(opts.dir, opts.policy, opts.timeZone) : [];
    record = { kind: opts.kind, startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(), ok: true, file: basename(result.path), error: null, pruned };
  } catch (err) {
    record = { kind: opts.kind, startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(), ok: false, file: null, error: (err as Error).message || String(err), pruned: [] };
  }
  await recordBackupRun(opts.dir, record).catch(() => undefined);
  return record;
}
