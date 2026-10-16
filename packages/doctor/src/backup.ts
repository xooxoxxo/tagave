import { execFile } from 'node:child_process';
import { readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { readRenamedEnv, tagaveEnv } from '@tagave/shared/env';
import { ensureDir } from './ensureDir.js';

const run = promisify(execFile);

export const BACKUP_PREFIX = 'tagave-';
/**
 * The prefixes of this app's own dumps: tagave- and, from releases before
 * 0.9, liner-. Dumps with either are listed, restored, pruned and sorted by
 * time together. The old one is never written again.
 */
const OWN_PREFIX_RE = /^(?:tagave|liner)-/;
export const BACKUP_SUFFIX = '.pgdump';
/** Written next to each dump by runBackup: what kind it is and whether pg_restore could read it back. */
export const SIDECAR_SUFFIX = '.json';

/**
 * Why a dump exists. Each kind has its own retention in backup-settings.json
 * (see pruneKind), applied after a successful run of that kind:
 * - nightly: the scheduled job; keepDaily + keepWeekly.
 * - manual: "Back up now" or `tagave-doctor backup`; keepManual (null keeps
 *   them until the owner deletes them).
 * - pre-migration ("Before update" on the page): taken by the app before it
 *   applies database updates (premigrate.ts), and by the updater with
 *   `tagave-doctor backup --kind before-update`; keepPreUpdate.
 * - pre-restore: taken by `tagave-doctor restore --in-place` before it
 *   replaces the data; kept until the owner deletes them.
 */
export const BACKUP_KINDS = ['nightly', 'manual', 'pre-migration', 'pre-restore'] as const;
export type BackupKind = (typeof BACKUP_KINDS)[number];

/**
 * `tagave-doctor backup --kind <value>`: before-update (the updater's dump,
 * filed with the app's own pre-migration dumps; `pre-migration` is accepted
 * too), nightly or manual. pre-restore is only written by restore.
 */
export const CLI_BACKUP_KINDS = ['before-update', 'nightly', 'manual'] as const;
export function parseCliBackupKind(value: string): BackupKind | null {
  if (value === 'before-update' || value === 'pre-migration') return 'pre-migration';
  if (value === 'nightly' || value === 'manual') return value;
  return null;
}

/**
 * tagave-2026-09-08T00-30-00Z-nightly.pgdump — no colons so SMB/Windows
 * shares accept it. The kind suffix is left off for manual dumps, which
 * keeps the shape older releases wrote (with the liner- prefix before 0.9).
 */
export function backupFileName(now: Date, kind: BackupKind = 'manual'): string {
  const ts = now.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');
  return `${BACKUP_PREFIX}${ts}${kind === 'manual' ? '' : `-${kind}`}${BACKUP_SUFFIX}`;
}

const NAME_RE = /^(?:tagave|liner)-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z(?:-([a-z-]+))?\.pgdump$/;

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

/**
 * Kind the file name itself declares, for files this app wrote (tagave-<time>,
 * or liner-<time> before 0.9, with an optional known kind suffix), or null for anything else. Unlike
 * parseBackupName this never guesses: it decides what may be deleted.
 */
export function ownKind(name: string): BackupKind | null {
  const m = NAME_RE.exec(name);
  if (!m) return null;
  if (m[5] === undefined) return 'manual';
  return (BACKUP_KINDS as readonly string[]).includes(m[5]) ? (m[5] as BackupKind) : null;
}

/**
 * Oldest first for this app's dump names, whichever prefix they carry: the
 * name after the prefix starts with the UTC time, so it sorts by time.
 */
export function compareBackupNames(a: string, b: string): number {
  const key = (n: string) => n.replace(OWN_PREFIX_RE, '');
  const ka = key(a);
  const kb = key(b);
  if (ka !== kb) return ka < kb ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Dump files this app wrote among `files`, oldest first. Foreign files in the directory are never touched. */
export function ownBackups(files: string[]): string[] {
  return files.filter((f) => ownKind(f) !== null).sort(compareBackupNames);
}

/**
 * Files to delete so that only the newest `keep` dumps of `kind` (manual by
 * default) remain (`tagave-doctor backup --keep N`). Other kinds are left
 * alone.
 */
export function pruneList(files: string[], keep: number, kind: BackupKind = 'manual'): string[] {
  const own = files.filter((f) => ownKind(f) === kind).sort(compareBackupNames);
  if (keep < 0) return [];
  return own.slice(0, Math.max(0, own.length - keep));
}

/** `pg_restore --list` prints one line per archive entry ("123; 1259 16384 TABLE public albums tagave"); comment lines start with ';'. */
export function countTocEntries(listing: string): number {
  return listing.split('\n').filter((line) => /^\d+;/.test(line)).length;
}

/**
 * Where dumps go: BACKUP_DIR (the compose files mount a dedicated backups
 * volume there), LINER_BACKUP_DIR (its pre-0.9 name, until 0.10), then CACHE_DIR/backups for a
 * source install, then ./backups.
 */
export function defaultBackupDir(env: NodeJS.ProcessEnv, cwd = process.cwd()): string {
  const explicit = env['BACKUP_DIR'] || readRenamedEnv('BACKUP_DIR', 'LINER_BACKUP_DIR', env);
  if (explicit) return explicit;
  const cacheDir = env['CACHE_DIR'];
  if (cacheDir) return join(cacheDir, 'backups');
  return join(cwd, 'backups');
}

/**
 * Whether `dir` is on a different filesystem from `/`. In a container that
 * means a volume or a host folder is mounted there; otherwise files written
 * to it live in the container and are lost when it is recreated. Returns
 * null when either path cannot be read.
 */
export function isSeparateMount(dir: string, root = '/'): boolean | null {
  try {
    return statSync(dir).dev !== statSync(root).dev;
  } catch {
    return null;
  }
}

/** The app image sets TAGAVE_BACKUP_REQUIRE_MOUNT=1: there, a backup folder that is not a mount does not survive. */
export function backupMountRequired(env: NodeJS.ProcessEnv): boolean {
  return /^(1|true|yes|on)$/i.test((tagaveEnv('BACKUP_REQUIRE_MOUNT', env) ?? '').trim());
}

export interface BackupOptions {
  databaseUrl: string;
  outDir: string;
  kind?: BackupKind;
  /** Dumps of this kind to keep in outDir including the new one; undefined keeps everything. Other kinds are never pruned here. */
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

/** Replace the password in any postgres:// URL (and password=… parameters) in `text`. */
export function redactSecrets(text: string): string {
  return text
    .replace(/(postgres(?:ql)?:\/\/[^:/?#@\s]*):[^@\s]*@/gi, '$1:***@')
    .replace(/(password=)[^&\s]+/gi, '$1***');
}

export function describeExecError(err: unknown, binary: string): string {
  const e = err as NodeJS.ErrnoException & { stderr?: string; signal?: string | null };
  if (e.code === 'ENOENT') {
    return `${binary} not found on PATH — install postgresql-client-16 (the app image ships it) or point PG_DUMP/PG_RESTORE at the binaries`;
  }
  const stderr = redactSecrets((e.stderr ?? '').trim());
  if (stderr) return `${binary}: ${stderr.split('\n').slice(-3).join(' | ')}`;
  // execFile's own message repeats the whole command line; never pass it on.
  if (e.signal) return `${binary} was stopped by ${e.signal} (out of memory, or killed)`;
  if (typeof e.code === 'number') return `${binary} exited with code ${e.code}`;
  return `${binary}: ${redactSecrets(e.message ?? String(err))}`;
}

/**
 * Connection for pg_dump / pg_restore without the password on the command
 * line: the URL loses its password, which goes to the child through
 * PGPASSWORD instead (argv shows up in ps and in execFile's error message).
 */
export function pgConnection(databaseUrl: string): { dbname: string; env: NodeJS.ProcessEnv } {
  const env: NodeJS.ProcessEnv = { ...process.env };
  let u: URL;
  try {
    u = new URL(databaseUrl);
  } catch {
    return { dbname: databaseUrl, env };
  }
  if (u.password) {
    env['PGPASSWORD'] = decodeURIComponent(u.password);
    u.password = '';
  }
  const qp = u.searchParams.get('password');
  if (qp !== null) {
    env['PGPASSWORD'] = qp;
    u.searchParams.delete('password');
  }
  return { dbname: u.toString(), env };
}

/**
 * Tables whose rows a backup leaves out: the schema is dumped (a restore
 * gets the empty table) but not the data, because it is rebuilt afterwards.
 *
 * cover_thumbs, from every dump: worker-files regenerates each thumbnail
 * from the original on its cache volume (art.thumb, a few minutes).
 *
 * provider_cache, from nightly and manual dumps: answers from MusicBrainz,
 * Discogs, AcoustID and the rest, asked again as they are needed. The
 * pre-migration dumps (the app's, and the updater's `--kind before-update`,
 * filed as one) and the pre-restore dumps keep it: they are what a roll
 * back restores, and a
 * cold cache would make the rolled-back app re-ask the slow providers
 * (AcoustID) and lose its fingerprint statistics.
 *
 * The installer's pre-update dump, a roll back point too, keeps the provider
 * cache; the manual dump commands in the docs and the in-app guide leave both
 * out.
 */
export const EXCLUDED_TABLE_DATA = ['public.cover_thumbs', 'public.provider_cache'] as const;

/** Rollback dumps: they keep the provider cache. */
const KEEPS_PROVIDER_CACHE: ReadonlySet<BackupKind> = new Set(['pre-migration', 'pre-restore']);

/** The tables a dump of this kind leaves the rows out of. */
export function excludedTableData(kind: BackupKind): string[] {
  return KEEPS_PROVIDER_CACHE.has(kind) ? ['public.cover_thumbs'] : [...EXCLUDED_TABLE_DATA];
}

/** The pg_dump arguments that leave those rows out. */
export function excludedTableDataArgs(kind: BackupKind): string[] {
  return excludedTableData(kind).map((t) => `--exclude-table-data=${t}`);
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
  await ensureDir(opts.outDir);
  const fileName = backupFileName(now, kind);
  const path = join(opts.outDir, fileName);
  const partial = join(opts.outDir, `.${fileName}.partial`);

  try {
    const conn = pgConnection(opts.databaseUrl);
    await run(pgDumpBin(opts.pgDump), ['--format=custom', '--no-password', ...excludedTableDataArgs(kind), `--file=${partial}`, `--dbname=${conn.dbname}`], {
      maxBuffer: 16 * 1024 * 1024,
      env: conn.env,
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
    for (const old of pruneList(others, Math.max(0, opts.keep - 1), kind)) {
      await removeDump(opts.outDir, old);
      pruned.push(old);
    }
  }

  return { path, kind, bytes, tocEntries, pruned, durationMs: Date.now() - started };
}

export const BACKUP_USAGE = 'usage: backup [--kind before-update|nightly|manual] [--out DIR] [--keep N] [--json]';

export type BackupArgs =
  | { ok: true; outDir: string; keep: number | undefined; kind: BackupKind; json: boolean }
  | { ok: false; error: string };

/** The options of `tagave-doctor backup` (everything after the word backup). */
export function parseBackupArgs(args: string[], defaultOutDir: string): BackupArgs {
  let outDir = defaultOutDir;
  let keep: number | undefined;
  let kind: BackupKind = 'manual';
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg === '--json') {
      json = true;
    } else if (arg === '--out' && next !== undefined) {
      outDir = next;
      i++;
    } else if (arg === '--kind' && next !== undefined) {
      const parsed = parseCliBackupKind(next);
      if (parsed === null) return { ok: false, error: `--kind expects before-update, nightly or manual, not ${next}; ${BACKUP_USAGE}` };
      kind = parsed;
      i++;
    } else if (arg === '--keep' && next !== undefined) {
      const parsed = parseInt(next, 10);
      if (!Number.isInteger(parsed) || parsed < 1) {
        return { ok: false, error: '--keep expects a positive integer (dumps of this kind to keep, including this one)' };
      }
      keep = parsed;
      i++;
    } else {
      return { ok: false, error: `unknown option ${arg}; ${BACKUP_USAGE}` };
    }
  }
  return { ok: true, outDir, keep, kind, json };
}

/**
 * `tagave-doctor backup`: one dump of `kind`, then the older ones of that kind
 * go, by `keep` when given, else by the retention saved on Settings › Backups
 * in that folder. A failed prune is reported, not thrown: the dump is good.
 */
export async function backupWithRetention(
  opts: BackupOptions & { env?: NodeJS.ProcessEnv; timeZone?: string; onPruneError?: (err: Error) => void },
): Promise<BackupResult> {
  const result = await runBackup(opts);
  if (opts.keep !== undefined) return result;
  try {
    const env = opts.env ?? process.env;
    if (result.kind === 'pre-migration') await adoptLegacyPreUpdateKeep(opts.outDir, env, basename(result.path));
    result.pruned = await pruneKind(
      opts.outDir,
      result.kind,
      await readBackupSettings(opts.outDir, env),
      opts.timeZone ?? (env['TZ'] || 'UTC'),
      basename(result.path),
    );
  } catch (err) {
    opts.onPruneError?.(err as Error);
  }
  return result;
}

/**
 * Delete this app's older dumps of `kind` in `outDir` so only the newest
 * `keep` remain. The newest one is always kept, whatever `keep` says.
 * Returns the names removed.
 */
export async function pruneBackups(outDir: string, keep: number, kind: BackupKind): Promise<string[]> {
  const ours = (await readdir(outDir)).filter((f) => ownKind(f) === kind).sort(compareBackupNames);
  const doomed = keep < 0 ? [] : ours.slice(0, Math.max(0, ours.length - Math.max(1, keep)));
  for (const old of doomed) await removeDump(outDir, old);
  return doomed;
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
  // Only dumps this app named as nightly: a foreign "*nightly*.pgdump" in a
  // shared folder is listed (kind guessed from its name) but never deleted.
  const nightly = entries
    .filter((e) => e.kind === 'nightly' && ownKind(e.name) === 'nightly')
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
// Retention per kind, from the saved settings. Only this app's own dump names
// (ownKind) are ever deleted, the newest dump of a kind never is, and a
// lowered number deletes nothing until the next run of that kind (D5): the
// page shows what that run will delete with kindDeletes(..., nextRun).

/** Names of this app's `kind` dumps among `entries` that the settings no longer keep. */
export function kindDeletes(
  entries: Array<{ name: string; kind: BackupKind; createdAt: string }>,
  kind: BackupKind,
  settings: BackupSettings,
  timeZone = process.env['TZ'] || 'UTC',
  /** As if a dump of this kind had been written at this time: what the next run deletes. */
  nextRun?: Date,
): string[] {
  // One phantom per run. For before-update that is one per update: the new
  // app's pre-migration dump, or the updater's own (--kind before-update),
  // and then the updater starts the new app with
  // TAGAVE_SKIP_PREMIGRATE_BACKUP=1 for that boot (updater rollback-dump.ts).
  // An in-app update never writes two of this kind.
  const phantom = nextRun ? backupFileName(nextRun, kind) : null;
  const all = phantom && !entries.some((e) => e.name === phantom)
    ? [...entries, { name: phantom, kind, createdAt: nextRun!.toISOString() }]
    : entries;
  let doomed: string[];
  if (kind === 'nightly') {
    doomed = retentionDeletes(all, { keepDaily: settings.keepDaily, keepWeekly: settings.keepWeekly }, timeZone);
  } else {
    const keep = kind === 'pre-migration' ? settings.keepPreUpdate : kind === 'manual' ? settings.keepManual : null;
    if (keep === null) return [];
    // Both the name and the record must say this kind, as for nightly: a dump
    // whose sidecar says another kind is never deleted here.
    const own = all.filter((e) => e.kind === kind && ownKind(e.name) === kind).map((e) => e.name).sort(compareBackupNames);
    doomed = own.slice(0, Math.max(0, own.length - Math.max(1, keep)));
  }
  return doomed.filter((n) => n !== phantom);
}

/**
 * Apply the saved retention of `kind` in `dir` after a run of that kind;
 * returns the names deleted. The newest dump of the kind is always kept, and
 * so is `justWritten`, the dump this run wrote: a dump named with a later time
 * (a clock that was wrong once) must not push the new one out.
 */
export async function pruneKind(
  dir: string,
  kind: BackupKind,
  settings: BackupSettings,
  timeZone?: string,
  justWritten?: string,
): Promise<string[]> {
  const entries = await listBackups(dir);
  const newest = entries
    .map((e) => e.name)
    .filter((n) => ownKind(n) === kind)
    .sort(compareBackupNames)
    .at(-1);
  const doomed = kindDeletes(entries, kind, settings, timeZone).filter((n) => n !== newest && n !== justWritten);
  for (const name of doomed) await removeDump(dir, name);
  return doomed;
}

/** The next time the nightly backup runs: the next whole hour that is `hour` o'clock in `timeZone`. */
export function nextNightlyRun(hour: number, timeZone: string, now = new Date()): Date {
  const zone = safeZone(timeZone);
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', hourCycle: 'h23' });
  const t = new Date(now);
  t.setUTCMinutes(0, 0, 0);
  for (let i = 0; i < 50; i++) {
    t.setTime(t.getTime() + 3_600_000);
    if (parseInt(fmt.format(t), 10) === hour) return t;
  }
  return new Date(now.getTime() + 86_400_000);
}

export interface BackupKindSummary {
  kind: BackupKind;
  count: number;
  bytes: number;
  /** When the newest dump of this kind was taken; null when there is none. */
  newest: string | null;
  /** What the next run of this kind deletes under the saved settings. */
  pendingDelete: { count: number; bytes: number; names: string[] };
}

/**
 * One block per kind for Settings › Backups: nightly, before update and
 * manual always, before restore only when there is one.
 */
export function summarizeKinds(entries: BackupEntry[], settings: BackupSettings, timeZone: string, now = new Date()): BackupKindSummary[] {
  const kinds: BackupKind[] = ['nightly', 'pre-migration', 'manual', 'pre-restore'];
  const out: BackupKindSummary[] = [];
  for (const kind of kinds) {
    const mine = entries.filter((e) => e.kind === kind);
    if (kind === 'pre-restore' && mine.length === 0) continue;
    let names: string[] = [];
    if (kind === 'nightly') {
      if (settings.enabled) names = kindDeletes(entries, kind, settings, timeZone, nextNightlyRun(settings.hour, timeZone, now));
    } else if (kind !== 'pre-restore') {
      names = kindDeletes(entries, kind, settings, timeZone, now);
    }
    const going = new Set(names);
    out.push({
      kind,
      count: mine.length,
      bytes: mine.reduce((sum, e) => sum + e.bytes, 0),
      newest: mine.reduce<string | null>((max, e) => (max === null || e.createdAt > max ? e.createdAt : max), null),
      pendingDelete: {
        count: names.length,
        bytes: entries.filter((e) => going.has(e.name)).reduce((sum, e) => sum + e.bytes, 0),
        names,
      },
    });
  }
  return out;
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
  /**
   * Before-update dumps to keep (the app's pre-migration dumps, and the
   * updater's once it passes --kind before-update). At least 2: that updater
   * change is planned after 0.9.0, and from then one in-app update writes two
   * dumps of this kind, both needed until the updater has checked the new
   * version. Until it lands one update writes one. The installer's host-side
   * backups/pre-update-* dumps are separate (install-tagave.sh keeps 3).
   */
  keepPreUpdate: number;
  /** Manual dumps to keep; null keeps them until the owner deletes them. */
  keepManual: number | null;
}

export const SETTINGS_LIMITS = {
  keepDaily: { min: 1, max: 90 },
  keepWeekly: { min: 0, max: 52 },
  hour: { min: 0, max: 23 },
  keepPreUpdate: { min: 2, max: 50 },
  keepManual: { min: 1, max: 100 },
} as const;

export const KEEP_PRE_UPDATE_DEFAULT = 3;

function envInt(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = parseInt(raw, 10);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

/**
 * TAGAVE_PREMIGRATE_BACKUP_KEEP (LINER_ before 0.9) as the default for
 * keepPreUpdate, brought into 2–50; a value saved on the page wins.
 */
export function envKeepPreUpdate(env: NodeJS.ProcessEnv): number {
  const n = Number.parseInt(tagaveEnv('PREMIGRATE_BACKUP_KEEP', env) ?? '', 10);
  if (!Number.isFinite(n)) return KEEP_PRE_UPDATE_DEFAULT;
  return Math.min(SETTINGS_LIMITS.keepPreUpdate.max, Math.max(SETTINGS_LIMITS.keepPreUpdate.min, n));
}

/**
 * Defaults: on, 03:00, keep 7 daily and 4 weekly, the newest 3 before-update
 * dumps and every manual one; BACKUP_HOUR / BACKUP_KEEP_DAILY /
 * BACKUP_KEEP_WEEKLY / BACKUP_NIGHTLY=off / TAGAVE_PREMIGRATE_BACKUP_KEEP
 * change them.
 */
export function defaultBackupSettings(env: NodeJS.ProcessEnv = process.env): BackupSettings {
  return {
    enabled: !/^(0|false|off|no)$/i.test(env['BACKUP_NIGHTLY'] ?? ''),
    hour: envInt(env, 'BACKUP_HOUR', 3, SETTINGS_LIMITS.hour.min, SETTINGS_LIMITS.hour.max),
    keepDaily: envInt(env, 'BACKUP_KEEP_DAILY', 7, SETTINGS_LIMITS.keepDaily.min, SETTINGS_LIMITS.keepDaily.max),
    keepWeekly: envInt(env, 'BACKUP_KEEP_WEEKLY', 4, SETTINGS_LIMITS.keepWeekly.min, SETTINGS_LIMITS.keepWeekly.max),
    keepPreUpdate: envKeepPreUpdate(env),
    keepManual: null,
  };
}

function clampInt(v: unknown, fallback: number, min: number, max: number): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : fallback;
}

function clampNullable(v: unknown, fallback: number | null, min: number, max: number): number | null {
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
  const L = SETTINGS_LIMITS;
  return {
    enabled: typeof raw['enabled'] === 'boolean' ? raw['enabled'] : defaults.enabled,
    hour: clampInt(raw['hour'], defaults.hour, L.hour.min, L.hour.max),
    keepDaily: clampInt(raw['keepDaily'], defaults.keepDaily, L.keepDaily.min, L.keepDaily.max),
    keepWeekly: clampInt(raw['keepWeekly'], defaults.keepWeekly, L.keepWeekly.min, L.keepWeekly.max),
    keepPreUpdate: clampInt(raw['keepPreUpdate'], defaults.keepPreUpdate, L.keepPreUpdate.min, L.keepPreUpdate.max),
    // A saved null means "until I delete"; a missing or broken value is the default.
    keepManual: raw['keepManual'] === null ? null : clampNullable(raw['keepManual'], defaults.keepManual, L.keepManual.min, L.keepManual.max),
  };
}

/** The number of before-update dumps releases before per-kind retention kept. */
export const LEGACY_KEEP_PRE_UPDATE = 5;

/**
 * Once, for an install that has before-update dumps from a release that kept
 * 5 of them: save keepPreUpdate 5 in backup-settings.json, so the first boot
 * of this release does not delete 2 of them under the new default of 3. Only
 * when nothing is saved for it and TAGAVE_PREMIGRATE_BACKUP_KEEP is unset;
 * `ignore` is a dump this run just wrote, which does not count. The other
 * saved settings are left as they are. Returns whether it saved.
 */
export async function adoptLegacyPreUpdateKeep(dir: string, env: NodeJS.ProcessEnv, ignore?: string): Promise<boolean> {
  if ((tagaveEnv('PREMIGRATE_BACKUP_KEEP', env) ?? '').trim() !== '') return false;
  const path = join(dir, SETTINGS_FILE);
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  } catch (err) {
    // A file that is there but unreadable is left alone; a missing one is fine.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return false;
  }
  if (typeof raw !== 'object' || raw === null || raw['keepPreUpdate'] !== undefined) return false;
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return false;
  }
  if (!names.some((n) => n !== ignore && ownKind(n) === 'pre-migration')) return false;
  await writeJsonAtomic(path, { ...raw, keepPreUpdate: LEGACY_KEEP_PRE_UPDATE });
  return true;
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\n');
  await rename(tmp, path);
}

export async function writeBackupSettings(dir: string, settings: BackupSettings): Promise<void> {
  await ensureDir(dir);
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
  await ensureDir(dir);
  await writeJsonAtomic(join(dir, STATUS_FILE), next);
}

/**
 * One scheduled or on-demand backup: dump + verify, prune older dumps of the
 * same kind by the saved settings, and record the outcome in the status file
 * (a failure too, so the Backups page can say the last night failed and why).
 * A failed run deletes nothing.
 */
export async function runRecordedBackup(opts: {
  databaseUrl: string;
  dir: string;
  kind: 'nightly' | 'manual';
  /** Retention to apply after the run; none prunes nothing. */
  settings?: BackupSettings;
  timeZone?: string;
  now?: Date;
}): Promise<BackupRunRecord> {
  const startedAt = new Date();
  let record: BackupRunRecord;
  try {
    const result = await runBackup({ databaseUrl: opts.databaseUrl, outDir: opts.dir, kind: opts.kind, ...(opts.now ? { now: opts.now } : {}) });
    const pruned = opts.settings ? await pruneKind(opts.dir, opts.kind, opts.settings, opts.timeZone, basename(result.path)) : [];
    record = { kind: opts.kind, startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(), ok: true, file: basename(result.path), error: null, pruned };
  } catch (err) {
    record = { kind: opts.kind, startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(), ok: false, file: null, error: redactSecrets((err as Error).message || String(err)), pruned: [] };
  }
  await recordBackupRun(opts.dir, record).catch(() => undefined);
  return record;
}
