import { execFile } from 'node:child_process';
import { mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export const BACKUP_PREFIX = 'liner-';
export const BACKUP_SUFFIX = '.pgdump';

/** liner-2026-09-08T00-30-00Z.pgdump — sorts chronologically; no colons so SMB/Windows shares accept it. */
export function backupFileName(now: Date, prefix: string = BACKUP_PREFIX): string {
  const ts = now.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');
  return `${prefix}${ts}${BACKUP_SUFFIX}`;
}

/** Our dump files among `files`, oldest first. Foreign files in the directory are never touched. */
export function ownBackups(files: string[], prefix: string = BACKUP_PREFIX): string[] {
  return files.filter((f) => f.startsWith(prefix) && f.endsWith(BACKUP_SUFFIX)).sort();
}

/** Files to delete so that only the newest `keep` of our dumps remain. */
export function pruneList(files: string[], keep: number, prefix: string = BACKUP_PREFIX): string[] {
  const ours = ownBackups(files, prefix);
  if (keep < 0) return [];
  return ours.slice(0, Math.max(0, ours.length - keep));
}

/** `pg_restore --list` prints one line per archive entry ("123; 1259 16384 TABLE public albums liner"); comment lines start with ';'. */
export function countTocEntries(listing: string): number {
  return listing.split('\n').filter((line) => /^\d+;/.test(line)).length;
}

export function defaultBackupDir(env: NodeJS.ProcessEnv, cwd = process.cwd()): string {
  const explicit = env['LINER_BACKUP_DIR'];
  if (explicit) return explicit;
  const cacheDir = env['CACHE_DIR'];
  if (cacheDir) return join(cacheDir, 'backups');
  return join(cwd, 'backups');
}

export interface BackupOptions {
  databaseUrl: string;
  outDir: string;
  /** Total dumps to keep in outDir including the new one; undefined keeps everything. */
  keep?: number;
  now?: Date;
  pgDump?: string;
  pgRestore?: string;
  /** File-name prefix; pruning only ever touches files with this prefix. */
  prefix?: string;
}

export interface BackupResult {
  path: string;
  bytes: number;
  tocEntries: number;
  pruned: string[];
  durationMs: number;
}

/**
 * Split the password out of a connection URL, so pg_dump gets it through
 * PGPASSWORD and it never appears on argv (the process list) or in an error
 * message that quotes the command line.
 */
export function splitDatabasePassword(databaseUrl: string): { url: string; password: string | null } {
  try {
    const u = new URL(databaseUrl);
    if (!u.password) return { url: databaseUrl, password: null };
    const password = decodeURIComponent(u.password);
    u.password = '';
    return { url: u.toString(), password };
  } catch {
    return { url: databaseUrl, password: null };
  }
}

/** Remove credentials from text that may quote a connection URL or the pg_dump command line. */
export function redactSecrets(text: string): string {
  return text
    .replace(/--dbname=\S+/g, '--dbname=<redacted>')
    .replace(/(\w+:\/\/[^:/@\s]*):[^@\s]*@/g, '$1:<redacted>@');
}

function describeExecError(err: unknown, binary: string): string {
  const e = err as NodeJS.ErrnoException & { stderr?: string; signal?: string | null };
  if (e.code === 'ENOENT') {
    return `${binary} not found on PATH — install postgresql-client-16 (the app image ships it) or point PG_DUMP/PG_RESTORE at the binaries`;
  }
  const stderr = (e.stderr ?? '').trim();
  if (stderr) return redactSecrets(`${binary}: ${stderr.split('\n').slice(-3).join(' | ')}`);
  // No stderr: killed (out of memory, a signal). Never echo e.message: it quotes the command line.
  if (e.signal) return `${binary} was stopped by ${e.signal} (out of memory?)`;
  return redactSecrets(`${binary}: ${e.message}`);
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

/** The app image sets LINER_BACKUP_REQUIRE_MOUNT=1: there, a backup folder that is not a mount does not survive. */
export function backupMountRequired(env: NodeJS.ProcessEnv): boolean {
  return /^(1|true|yes|on)$/i.test((env['LINER_BACKUP_REQUIRE_MOUNT'] ?? '').trim());
}

/** Delete our older dumps in `outDir` so only the newest `keep` remain. Returns the names removed. */
export async function pruneBackups(outDir: string, keep: number, prefix: string = BACKUP_PREFIX): Promise<string[]> {
  const pruned: string[] = [];
  for (const old of pruneList(await readdir(outDir), keep, prefix)) {
    await unlink(join(outDir, old));
    pruned.push(old);
  }
  return pruned;
}

/**
 * pg_dump -Fc of the database, verified with pg_restore --list (a truncated or
 * empty archive fails here instead of at restore time), then prune older dumps.
 * The partial file is removed on any failure.
 */
export async function runBackup(opts: BackupOptions): Promise<BackupResult> {
  const started = Date.now();
  const pgDump = opts.pgDump ?? process.env['PG_DUMP'] ?? 'pg_dump';
  const pgRestore = opts.pgRestore ?? process.env['PG_RESTORE'] ?? 'pg_restore';
  await mkdir(opts.outDir, { recursive: true });
  const prefix = opts.prefix ?? BACKUP_PREFIX;
  const fileName = backupFileName(opts.now ?? new Date(), prefix);
  const path = join(opts.outDir, fileName);

  const { url, password } = splitDatabasePassword(opts.databaseUrl);
  try {
    await run(pgDump, ['--format=custom', '--no-password', `--file=${path}`, `--dbname=${url}`], {
      maxBuffer: 16 * 1024 * 1024,
      env: password === null ? process.env : { ...process.env, PGPASSWORD: password },
    });
  } catch (err) {
    await unlink(path).catch(() => undefined);
    throw new Error(describeExecError(err, 'pg_dump'));
  }

  let tocEntries: number;
  try {
    const { stdout } = await run(pgRestore, ['--list', path], { maxBuffer: 64 * 1024 * 1024 });
    tocEntries = countTocEntries(stdout);
  } catch (err) {
    await unlink(path).catch(() => undefined);
    throw new Error(describeExecError(err, 'pg_restore --list'));
  }
  if (tocEntries === 0) {
    await unlink(path).catch(() => undefined);
    throw new Error('pg_restore --list found no entries in the dump');
  }
  const bytes = (await stat(path)).size;
  if (bytes === 0) {
    await unlink(path).catch(() => undefined);
    throw new Error('pg_dump wrote an empty file');
  }

  const pruned: string[] = [];
  if (opts.keep !== undefined) {
    const others = (await readdir(opts.outDir)).filter((f) => f !== fileName);
    for (const old of pruneList(others, Math.max(0, opts.keep - 1), prefix)) {
      await unlink(join(opts.outDir, old));
      pruned.push(old);
    }
  }

  return { path, bytes, tocEntries, pruned, durationMs: Date.now() - started };
}
