import {
  checkDatabase,
  checkMigrations,
  checkContactString,
  checkWorkerHeartbeat,
  checkWorkerVersions,
  checkScanRoots,
  checkCacheDir,
  checkProviders,
  checkAppSecret,
  type Check,
} from './checks.js';
import { checkBackups } from './backupCheck.js';
import { checkPublicUrl } from './authCheck.js';
import { checkDisk } from './diskCheck.js';

export type { Check, CheckStatus } from './checks.js';
export { remediationFor } from './remediation.js';
export { checkPublicUrl } from './authCheck.js';
export {
  checkDisk,
  diskSpace,
  publicDiskCheck,
  readDiskThresholds,
  resetDiskCache,
  resetDiskStateForTests,
  DEFAULT_DISK_WARN_PCT,
  DEFAULT_DISK_FAIL_PCT,
  type DiskSpaceOptions,
} from './diskCheck.js';
export {
  migrateOnBoot,
  preMigrationBackup,
  backupFolderProblem,
  preMigrationKeep,
  skipPreMigrationBackup,
  allowSchemaSkew,
  PREMIGRATE_KIND,
} from './premigrate.js';
export {
  BACKUP_KINDS,
  CLI_BACKUP_KINDS,
  KEEP_PRE_UPDATE_DEFAULT,
  EXCLUDED_TABLE_DATA,
  excludedTableData,
  SETTINGS_LIMITS,
  applyRetention,
  kindDeletes,
  nextNightlyRun,
  parseCliBackupKind,
  pruneKind,
  summarizeKinds,
  defaultBackupDir,
  defaultBackupSettings,
  deleteBackup,
  isSafeBackupName,
  listBackups,
  pgDumpBin,
  pgRestoreBin,
  readBackupSettings,
  readBackupStatus,
  retentionDeletes,
  runBackup,
  runRecordedBackup,
  writeBackupSettings,
  type BackupEntry,
  type BackupKind,
  type BackupKindSummary,
  type BackupRunRecord,
  type BackupSettings,
  type BackupStatusFile,
  type RetentionPolicy,
} from './backup.js';
export { runRestore, type RestoreOptions, type RestoreResult } from './restore.js';
export { MODULE_DATA, PurgeRefused, describePurge, purgeModuleData, type ModuleData, type PurgeResult } from './modulePurge.js';

export interface DoctorOptions {
  databaseUrl: string;
  cacheDir?: string;
  /** Pre-migration backup folder; BACKUP_DIR (then CACHE_DIR/backups) when absent. */
  backupDir?: string;
  expectWorkers?: number;
  offline?: boolean;
  /** What the skipped provider check says when offline (the CLI names its flag). */
  offlineDetail?: string;
  timeoutMs?: number;
  /** Only this library's music folders; every library's when absent. */
  libraryId?: string;
  /** Look for each music folder on this host too (default true). */
  probeHost?: boolean;
}

export interface DoctorResult {
  ok: boolean;
  checks: Check[];
}

export async function runDoctor(opts: DoctorOptions): Promise<DoctorResult> {
  const {
    databaseUrl,
    cacheDir,
    expectWorkers = 1,
    offline = false,
    offlineDetail,
    timeoutMs = 10000,
    libraryId,
    probeHost,
    backupDir,
  } = opts;

  const checks: Check[] = [];

  // Run all checks in sequence
  checks.push(await checkDatabase(databaseUrl));
  checks.push(await checkMigrations(databaseUrl));
  checks.push(await checkContactString(databaseUrl));
  checks.push(await checkWorkerHeartbeat(databaseUrl, expectWorkers));
  checks.push(await checkWorkerVersions(databaseUrl));
  checks.push(await checkScanRoots(databaseUrl, {
    ...(libraryId ? { libraryId } : {}),
    ...(probeHost !== undefined ? { probeHost } : {}),
  }));
  checks.push(await checkCacheDir(cacheDir));
  checks.push(await checkBackups(databaseUrl, backupDir ? { backupDir } : {}));
  checks.push(await checkDisk({
    databaseUrl,
    ...(cacheDir ? { cacheDir } : {}),
    ...(backupDir ? { backupDir } : {}),
  }));
  checks.push(await checkProviders(databaseUrl, offline, timeoutMs, offlineDetail));
  checks.push(await checkAppSecret(databaseUrl));
  checks.push(await checkPublicUrl(databaseUrl));

  // Determine if all checks passed (warnings are not failures)
  const ok = checks.every((c) => c.status !== 'fail');

  return { ok, checks };
}
