/**
 * The automatic backup the app takes before it applies pending migrations.
 * Migrations are forward-only, so this dump is the rollback: put the previous
 * version back and restore it. A failed backup stops the migration unless
 * the owner explicitly opts out.
 */
import { access } from 'node:fs/promises';
import {
  PreMigrationBackupError,
  isRetryOfUpdate,
  runMigrations,
  type BackupRecord,
  type PreviousBackup,
  type RunMigrationsResult,
  type SchemaState,
} from '@liner/db';
import {
  backupMountRequired,
  defaultBackupDir,
  isSeparateMount,
  pruneBackups,
  runBackup,
  type BackupOptions,
  type BackupResult,
} from './backup.js';

export const PREMIGRATE_PREFIX = 'pre-migrate-';
export const PREMIGRATE_KEEP_DEFAULT = 5;

const truthy = (v: string | undefined) => v !== undefined && /^(1|true|yes|on)$/i.test(v.trim());

export function skipPreMigrationBackup(env: NodeJS.ProcessEnv): boolean {
  return truthy(env['LINER_SKIP_PREMIGRATE_BACKUP']);
}

export function allowSchemaSkew(env: NodeJS.ProcessEnv): boolean {
  return truthy(env['LINER_ALLOW_SCHEMA_SKEW']);
}

/** How many pre-migration dumps to keep (LINER_PREMIGRATE_BACKUP_KEEP, default 5, at least 1). */
export function preMigrationKeep(env: NodeJS.ProcessEnv): number {
  const n = Number.parseInt(env['LINER_PREMIGRATE_BACKUP_KEEP'] ?? '', 10);
  return Number.isFinite(n) && n >= 1 ? n : PREMIGRATE_KEEP_DEFAULT;
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
}

/**
 * The plain reason the backup folder will not keep a dump, or null. Only the
 * app image asks for a mount (LINER_BACKUP_REQUIRE_MOUNT=1): there, a folder
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
    if (skipPreMigrationBackup(env)) {
      log(`LINER_SKIP_PREMIGRATE_BACKUP is set: applying ${state.pending.length} migration(s) without a backup`);
      return { status: 'skipped', path: null, bytes: null, note: 'LINER_SKIP_PREMIGRATE_BACKUP' };
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
        `Not migrating: ${folderProblem}. Nothing was changed. Set LINER_BACKUP_REQUIRE_MOUNT=0 to write there ` +
          'anyway, or LINER_SKIP_PREMIGRATE_BACKUP=1 to migrate without a backup.',
      );
    }
    log(`backing up the database to ${outDir} before applying ${state.pending.length} migration(s)...`);
    try {
      // No pruning here: older dumps are pruned only after the migrations succeed.
      const result = await backup({
        databaseUrl: opts.databaseUrl,
        outDir,
        prefix: PREMIGRATE_PREFIX,
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
          '(the app image has it). Set LINER_BACKUP_DIR to use another folder, or set ' +
          'LINER_SKIP_PREMIGRATE_BACKUP=1 to migrate without a backup.',
      );
    }
  };
}

export interface MigrateOnBootOptions extends PreMigrationBackupOptions {
  appVersion: string;
  /** Tests only; the app uses the migrations shipped in @liner/db. */
  migrationsDir?: string;
}

/** What the app runs before it listens: lock, skew check, backup, migrate, then prune old dumps. */
export async function migrateOnBoot(opts: MigrateOnBootOptions): Promise<RunMigrationsResult> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((m: string) => console.log(m));
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
      const pruned = await pruneBackups(defaultBackupDir(env), preMigrationKeep(env), PREMIGRATE_PREFIX);
      if (pruned.length > 0) log(`removed ${pruned.length} older pre-migration backup(s): ${pruned.join(', ')}`);
    } catch (err) {
      log(`warning: could not remove older pre-migration backups: ${(err as Error).message}`);
    }
  }
  return result;
}
