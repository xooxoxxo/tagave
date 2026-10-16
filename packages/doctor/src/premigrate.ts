/**
 * The automatic backup the app takes before it applies pending migrations.
 * Migrations are forward-only, so this dump is the rollback: put the previous
 * version back and restore it. A failed backup stops the migration unless
 * the owner explicitly opts out.
 */
import { access } from 'node:fs/promises';
import { basename } from 'node:path';
import {
  PreMigrationBackupError,
  isRetryOfUpdate,
  runMigrations,
  type BackupRecord,
  type PreviousBackup,
  type RunMigrationsResult,
  type SchemaState,
} from '@tagave/db';
import {
  backupMountRequired,
  defaultBackupDir,
  adoptLegacyPreUpdateKeep,
  envKeepPreUpdate,
  isSeparateMount,
  pruneKind,
  readBackupSettings,
  runBackup,
  type BackupOptions,
  type BackupResult,
} from './backup.js';
import { tagaveEnv } from '@tagave/shared/env';
import type { DiskSpaceView } from '@tagave/shared';
import postgres from 'postgres';
import { diskSpace, formatDiskBytes, type DiskSpaceOptions } from './diskCheck.js';

/** Kind of the dump the app takes before it migrates: tagave-<time>-pre-migration.pgdump in the backups folder. */
export const PREMIGRATE_KIND = 'pre-migration' as const;
export const PREMIGRATE_KEEP_DEFAULT = 3;

const truthy = (v: string | undefined) => v !== undefined && /^(1|true|yes|on)$/i.test(v.trim());

export function skipPreMigrationBackup(env: NodeJS.ProcessEnv): boolean {
  return truthy(tagaveEnv('SKIP_PREMIGRATE_BACKUP', env));
}

export function allowSchemaSkew(env: NodeJS.ProcessEnv): boolean {
  return truthy(tagaveEnv('ALLOW_SCHEMA_SKEW', env));
}

/**
 * The default number of before-update dumps to keep when Settings › Backups
 * has not saved one: TAGAVE_PREMIGRATE_BACKUP_KEEP, default 3, brought into
 * 1–50. The saved keepPreUpdate wins (readBackupSettings).
 */
export function preMigrationKeep(env: NodeJS.ProcessEnv): number {
  return envKeepPreUpdate(env);
}

export interface PreMigrationBackupOptions {
  databaseUrl: string;
  env?: NodeJS.ProcessEnv;
  log?: (msg: string) => void;
  /** Test seam: replaces the pg_dump + pg_restore --list run. */
  backup?: (opts: BackupOptions) => Promise<BackupResult>;
  /** Test seam: whether the backup folder is a mount (volume or host folder). */
  isMount?: (dir: string) => boolean | null;
  /** This app's version; a retry of the same failed update reuses its first dump. */
  appVersion?: string;
  /** Test seam: bytes of cover thumbnails still in images.thumb_bytes. */
  thumbBytes?: (databaseUrl: string) => Promise<number>;
  /** Test seam: the free-space reading (diskSpace). */
  disk?: (opts: DiskSpaceOptions) => Promise<DiskSpaceView>;
}

/** The migration that moves the cover thumbnails into cover_thumbs (0046). */
export const COVER_THUMBS_MIGRATION = /^\d{4}_cover_thumbs\.sql$/;
/** It needs the thumbnails' size this many times over: the new table plus the write-ahead log. */
export const COVER_THUMBS_SPACE_FACTOR = 3;

async function storedThumbBytes(databaseUrl: string): Promise<number> {
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  try {
    const col = await sql`select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'images' and column_name = 'thumb_bytes'`;
    if (col.length === 0) return 0;
    const r = await sql`select coalesce(sum(octet_length(thumb_bytes)), 0)::bigint as n from images`;
    return Number(r[0]?.['n'] ?? 0);
  } finally {
    await sql.end({ timeout: 2 });
  }
}

/**
 * Why the pending migrations may not run for lack of disk, or null. Only
 * the cover thumbnail move (0046) needs notable room: about three times the
 * thumbnails' size on the database's disk while it runs. Measured where
 * Postgres keeps its data when that is visible, else on the backups
 * folder's disk (in Docker the volumes usually share one disk). When nothing
 * can be measured the migration goes ahead: this check only refuses on a
 * reading.
 */
export async function migrationSpaceProblem(
  state: SchemaState,
  opts: Pick<PreMigrationBackupOptions, 'databaseUrl' | 'env' | 'log' | 'thumbBytes' | 'disk'>,
): Promise<string | null> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((m: string) => console.log(m));
  const file = state.pending.find((f) => COVER_THUMBS_MIGRATION.test(f));
  if (!file || truthy(tagaveEnv('SKIP_MIGRATION_SPACE_CHECK', env))) return null;
  let bytes: number;
  let view: DiskSpaceView;
  try {
    bytes = await (opts.thumbBytes ?? storedThumbBytes)(opts.databaseUrl);
    if (bytes <= 0) return null;
    view = await (opts.disk ?? diskSpace)({ databaseUrl: opts.databaseUrl, env, fresh: true });
  } catch (err) {
    log(`warning: could not check the free space ${file} needs (${(err as Error).message}); migrating anyway`);
    return null;
  }
  const need = bytes * COVER_THUMBS_SPACE_FACTOR;
  const onDb = view.filesystems.find((f) => f.paths.some((p) => p.key === 'database'));
  const fsView = onDb ?? view.filesystems.find((f) => f.paths.some((p) => p.key === 'backups'));
  if (!fsView) {
    log(`warning: could not measure the free space ${file} needs (about ${formatDiskBytes(need)}); migrating anyway`);
    return null;
  }
  const where = onDb ? "the database's disk" : "the backups folder's disk (Postgres's own disk is not visible from here; in Docker it is usually the same one)";
  if (fsView.freeBytes >= need) {
    log(`${file} needs about ${formatDiskBytes(need)} free; ${where} has ${formatDiskBytes(fsView.freeBytes)}`);
    return null;
  }
  return (
    `${file} moves ${formatDiskBytes(bytes)} of cover thumbnails into their own table and needs about ` +
    `${formatDiskBytes(need)} free while it runs (the thumbnails three times over: the new table and the ` +
    `write-ahead log), but ${where} has ${formatDiskBytes(fsView.freeBytes)} free. Free space (see "Disk space" ` +
    'in the operations guide) and start the app again, or set TAGAVE_SKIP_MIGRATION_SPACE_CHECK=1 to migrate anyway'
  );
}

/**
 * The plain reason the backup folder will not keep a dump, or null. Only the
 * app image asks for a mount (TAGAVE_BACKUP_REQUIRE_MOUNT=1): there, a folder
 * that is not a volume or host folder is inside the container and is lost
 * when the container is recreated, for example by the rollback itself.
 */
export function backupFolderProblem(
  outDir: string,
  env: NodeJS.ProcessEnv,
  isMount: (dir: string) => boolean | null = isSeparateMount,
): string | null {
  if (!backupMountRequired(env)) return null;
  if (isMount(outDir) !== false) return null;
  return (
    `${outDir} is not a mounted volume or host folder, so a backup written there is lost when the container is ` +
    'recreated. This happens with a compose.yml from before automatic backups: re-run the installer, or add ' +
    `a volume at ${outDir} to the app service, then update again`
  );
}

/** The `beforeApply` hook for runMigrations: dump and verify, reuse the dump of a failed attempt, or refuse. */
export function preMigrationBackup(
  opts: PreMigrationBackupOptions,
): (state: SchemaState, previous?: PreviousBackup | null) => Promise<BackupRecord> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((m: string) => console.log(m));
  const backup = opts.backup ?? runBackup;
  return async (state, previous = null) => {
    const outDir = defaultBackupDir(env);
    const spaceProblem = await migrationSpaceProblem(state, { ...opts, env, log });
    if (spaceProblem) throw new PreMigrationBackupError(`Not migrating: ${spaceProblem}. Nothing was changed.`);
    if (skipPreMigrationBackup(env)) {
      log(`TAGAVE_SKIP_PREMIGRATE_BACKUP is set: applying ${state.pending.length} migration(s) without a backup`);
      return { status: 'skipped', path: null, bytes: null, note: 'TAGAVE_SKIP_PREMIGRATE_BACKUP' };
    }
    // A restart after this same update failed part way: the database is half
    // migrated, so a new dump would not be a rollback point. Keep the first one.
    if (previous && isRetryOfUpdate(previous, state, opts.appVersion) && previous.path) {
      const onDisk = await access(previous.path).then(
        () => true,
        () => false,
      );
      if (onDisk) {
        log(
          `an earlier attempt at this update stopped part way; keeping its backup ${previous.path} as the rollback ` +
            'point instead of taking a new one',
        );
        return { status: 'reused', path: previous.path, bytes: previous.bytes, note: `backup #${previous.id}` };
      }
    }
    const folderProblem = backupFolderProblem(outDir, env, opts.isMount);
    if (folderProblem) {
      throw new PreMigrationBackupError(
        `Not migrating: ${folderProblem}. Nothing was changed. Set TAGAVE_BACKUP_REQUIRE_MOUNT=0 to write there ` +
          'anyway, or TAGAVE_SKIP_PREMIGRATE_BACKUP=1 to migrate without a backup.',
      );
    }
    log(`backing up the database to ${outDir} before applying ${state.pending.length} migration(s)...`);
    try {
      // No pruning here: older dumps are pruned only after the migrations succeed.
      const result = await backup({
        databaseUrl: opts.databaseUrl,
        outDir,
        kind: PREMIGRATE_KIND,
      });
      if (!(result.bytes > 0) || !(result.tocEntries > 0)) {
        throw new Error('the dump is empty');
      }
      log(`backup written ${result.path} (${result.bytes} bytes, checked with pg_restore --list)`);
      return { status: 'ok', path: result.path, bytes: result.bytes };
    } catch (err) {
      throw new PreMigrationBackupError(
        `Not migrating: the backup before migrating failed (${(err as Error).message}). Nothing was changed. ` +
          `Check that ${outDir} exists, is writable and has free space, and that pg_dump 16 is installed ` +
          '(the app image has it). Set BACKUP_DIR to use another folder, or set ' +
          'TAGAVE_SKIP_PREMIGRATE_BACKUP=1 to migrate without a backup.',
      );
    }
  };
}

export interface MigrateOnBootOptions extends PreMigrationBackupOptions {
  appVersion: string;
  /** Tests only; the app uses the migrations shipped in @tagave/db. */
  migrationsDir?: string;
}

/** What the app runs before it listens: lock, skew check, backup, migrate, then prune old dumps. */
export async function migrateOnBoot(opts: MigrateOnBootOptions): Promise<RunMigrationsResult> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((m: string) => console.log(m));
  // Before this boot writes a dump: an install with dumps from a release that
  // kept 5 keeps 5 until the owner picks a number (adoptLegacyPreUpdateKeep).
  try {
    if (await adoptLegacyPreUpdateKeep(defaultBackupDir(env), env)) {
      log('kept the earlier default of 5 backups before an update (Settings › Backups changes it)');
    }
  } catch (err) {
    log(`warning: could not save the backup settings: ${(err as Error).message}`);
  }
  const result = await runMigrations(opts.databaseUrl, {
    appVersion: opts.appVersion,
    allowNewerSchema: allowSchemaSkew(env),
    beforeApply: preMigrationBackup(opts),
    ...(opts.log ? { log: opts.log } : {}),
    ...(opts.migrationsDir ? { migrationsDir: opts.migrationsDir } : {}),
  });
  // Only now that every migration applied: a failed run keeps all older dumps,
  // so restarts after a failure can never push the real pre-update dump out.
  if (result.backup && result.backup.status !== 'skipped') {
    try {
      const dir = defaultBackupDir(env);
      const justWritten = result.backup.path ? basename(result.backup.path) : undefined;
      const pruned = await pruneKind(dir, PREMIGRATE_KIND, await readBackupSettings(dir, env), env['TZ'] || 'UTC', justWritten);
      if (pruned.length > 0) log(`removed ${pruned.length} older pre-migration backup(s): ${pruned.join(', ')}`);
    } catch (err) {
      log(`warning: could not remove older pre-migration backups: ${(err as Error).message}`);
    }
  }
  return result;
}
