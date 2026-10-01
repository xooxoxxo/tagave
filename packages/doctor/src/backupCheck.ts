/**
 * "Backups before updates": can this host take the automatic backup the app
 * needs before it migrates, and what happened at the last update. A problem
 * here is a warning, not a failure: the app runs, but the next update that
 * carries a migration will refuse to start until it is fixed.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import postgres from 'postgres';
import type { Check } from './checks.js';
import { defaultBackupDir, isSeparateMount } from './backup.js';
import { backupFolderProblem } from './premigrate.js';

const run = promisify(execFile);

interface LastBackup {
  status: string;
  path: string | null;
  bytes: number | string | null;
  created_at: Date;
  to_version: string | null;
}

export interface BackupCheckOptions {
  /** Where the pre-migration dumps go; LINER_BACKUP_DIR (then CACHE_DIR/backups) when absent. */
  backupDir?: string;
  pgDump?: string;
  env?: NodeJS.ProcessEnv;
  /** Test seam: whether the backup folder is a mount (volume or host folder). */
  isMount?: (dir: string) => boolean | null;
}

/** "pg_dump (PostgreSQL) 16.4 (Debian 16.4-1.pgdg120+2)" -> 16 */
export function pgDumpMajor(versionOutput: string): number | null {
  const m = /\(PostgreSQL\)\s+(\d+)/.exec(versionOutput);
  return m ? Number(m[1]) : null;
}

// The health endpoint runs every few seconds; the pg_dump binary does not change.
const versionCache = new Map<string, { at: number; major: number | null; error: string | null }>();

async function pgDumpVersion(bin: string): Promise<{ major: number | null; error: string | null }> {
  const hit = versionCache.get(bin);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit;
  let entry: { at: number; major: number | null; error: string | null };
  try {
    const { stdout } = await run(bin, ['--version'], { timeout: 5_000 });
    entry = { at: Date.now(), major: pgDumpMajor(stdout), error: null };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    entry = { at: Date.now(), major: null, error: code === 'ENOENT' ? 'pg_dump is not installed on this host' : (err as Error).message };
  }
  versionCache.set(bin, entry);
  return entry;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export async function checkBackups(databaseUrl: string, opts: BackupCheckOptions = {}): Promise<Check> {
  const start = Date.now();
  const env = opts.env ?? process.env;
  const dir = opts.backupDir ?? defaultBackupDir(env);
  const bin = opts.pgDump ?? env['PG_DUMP'] ?? 'pg_dump';
  const problems: string[] = [];
  const done = (status: Check['status'], detail: string): Check => ({
    id: 'backups',
    title: 'Backups Before Updates',
    status,
    detail,
    durationMs: Date.now() - start,
  });

  // 1. The folder must take a file.
  try {
    await fs.mkdir(dir, { recursive: true });
    const probe = path.join(dir, `.liner-doctor-${process.pid}-${Date.now()}.tmp`);
    await fs.writeFile(probe, 'x');
    await fs.unlink(probe).catch(() => undefined);
  } catch (err) {
    problems.push(`backup folder ${dir} is not writable (${(err as NodeJS.ErrnoException).code ?? (err as Error).message})`);
  }

  // 2. In the app image the folder must be a volume or host folder, or the dump dies with the container.
  const folderProblem = backupFolderProblem(dir, env, opts.isMount ?? isSeparateMount);
  if (folderProblem) problems.push(`${folderProblem}; the app refuses to update until then`);

  let last = null as LastBackup | null;
  try {
    const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
    try {
      // 3. pg_dump refuses a server newer than itself.
      const v = await pgDumpVersion(bin);
      if (v.error) {
        problems.push(v.error);
      } else {
        const r = await sql`select current_setting('server_version_num')::int as n`;
        const serverMajor = Math.floor(Number(r[0]?.['n'] ?? 0) / 10000);
        if (v.major !== null && serverMajor > 0 && v.major < serverMajor) {
          problems.push(`pg_dump ${v.major} cannot back up the Postgres ${serverMajor} server`);
        }
      }
      // 4. The last update's backup.
      const t = await sql`select to_regclass('public._migration_backups') as t`;
      if (t[0]?.['t']) {
        const rows = await sql`
          select status, path, bytes, created_at, to_version
          from _migration_backups order by id desc limit 1`;
        last = (rows[0] as unknown as LastBackup | undefined) ?? null;
      }
    } finally {
      await sql.end({ timeout: 2 });
    }
  } catch (err) {
    problems.push(`could not read the backup record: ${(err as Error).message}`);
  }

  let lastLine = 'no update has migrated the database since automatic backups began';
  if (last) {
    const when = new Date(last.created_at).toISOString().slice(0, 16).replace('T', ' ');
    const to = last.to_version ? ` to ${last.to_version}` : '';
    if (last.status === 'skipped') {
      problems.push(`the last update${to} (${when} UTC) migrated without a backup (LINER_SKIP_PREMIGRATE_BACKUP was set)`);
    } else if (last.path) {
      let present = true;
      try {
        await fs.access(last.path);
      } catch {
        present = false;
      }
      lastLine = `last backup before an update${to}: ${last.path}${last.bytes ? `, ${formatBytes(Number(last.bytes))}` : ''}, ${when} UTC`;
      if (!present) problems.push(`the backup from the last update${to} is no longer at ${last.path}`);
    }
  }

  if (problems.length > 0) return done('warn', `${problems.join('; ')}. ${lastLine[0]!.toUpperCase()}${lastLine.slice(1)}.`);
  return done('pass', `${dir} is ready; ${lastLine}`);
}
