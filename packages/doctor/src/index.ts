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

export type { Check, CheckStatus } from './checks.js';
export { remediationFor } from './remediation.js';
export {
  BACKUP_KINDS,
  SETTINGS_LIMITS,
  applyRetention,
  defaultBackupDir,
  defaultBackupSettings,
  deleteBackup,
  isSafeBackupName,
  listBackups,
  readBackupSettings,
  readBackupStatus,
  retentionDeletes,
  runBackup,
  runRecordedBackup,
  writeBackupSettings,
  type BackupEntry,
  type BackupKind,
  type BackupRunRecord,
  type BackupSettings,
  type BackupStatusFile,
  type RetentionPolicy,
} from './backup.js';

export interface DoctorOptions {
  databaseUrl: string;
  cacheDir?: string;
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
  checks.push(await checkProviders(databaseUrl, offline, timeoutMs, offlineDetail));
  checks.push(await checkAppSecret(databaseUrl));

  // Determine if all checks passed (warnings are not failures)
  const ok = checks.every((c) => c.status !== 'fail');

  return { ok, checks };
}
