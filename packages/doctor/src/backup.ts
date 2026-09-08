import { execFile } from 'node:child_process';
import { mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export const BACKUP_PREFIX = 'liner-';
export const BACKUP_SUFFIX = '.pgdump';

/** liner-2026-09-08T00-30-00Z.pgdump — sorts chronologically; no colons so SMB/Windows shares accept it. */
export function backupFileName(now: Date): string {
  const ts = now.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');
  return `${BACKUP_PREFIX}${ts}${BACKUP_SUFFIX}`;
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
}

export interface BackupResult {
  path: string;
  bytes: number;
  tocEntries: number;
  pruned: string[];
  durationMs: number;
}

function describeExecError(err: unknown, binary: string): string {
  const e = err as NodeJS.ErrnoException & { stderr?: string };
  if (e.code === 'ENOENT') {
    return `${binary} not found on PATH — install postgresql-client-16 (the app image ships it) or point PG_DUMP/PG_RESTORE at the binaries`;
  }
  const stderr = (e.stderr ?? '').trim();
  return stderr ? `${binary}: ${stderr.split('\n').slice(-3).join(' | ')}` : `${binary}: ${e.message}`;
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
  const fileName = backupFileName(opts.now ?? new Date());
  const path = join(opts.outDir, fileName);

  try {
    await run(pgDump, ['--format=custom', '--no-password', `--file=${path}`, `--dbname=${opts.databaseUrl}`], {
      maxBuffer: 16 * 1024 * 1024,
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

  const pruned: string[] = [];
  if (opts.keep !== undefined) {
    const others = (await readdir(opts.outDir)).filter((f) => f !== fileName);
    for (const old of pruneList(others, Math.max(0, opts.keep - 1))) {
      await unlink(join(opts.outDir, old));
      pruned.push(old);
    }
  }

  return { path, bytes, tocEntries, pruned, durationMs: Date.now() - started };
}
