import {
  checkDatabase,
  checkMigrations,
  checkContactString,
  checkWorkerHeartbeat,
  checkScanRoots,
  checkCacheDir,
  checkProviders,
  checkAppSecret,
  type Check,
} from './checks.js';

export type { Check, CheckStatus } from './checks.js';

export interface DoctorOptions {
  databaseUrl: string;
  cacheDir?: string;
  expectWorkers?: number;
  offline?: boolean;
  timeoutMs?: number;
}

export interface DoctorResult {
  ok: boolean;
  checks: Check[];
}

export async function runDoctor(opts: DoctorOptions): Promise<DoctorResult> {
  const {
    databaseUrl,
    cacheDir,
    expectWorkers = 2,
    offline = false,
    timeoutMs = 10000,
  } = opts;

  const checks: Check[] = [];

  // Run all checks in sequence
  checks.push(await checkDatabase(databaseUrl));
  checks.push(await checkMigrations(databaseUrl));
  checks.push(await checkContactString(databaseUrl));
  checks.push(await checkWorkerHeartbeat(databaseUrl, expectWorkers));
  checks.push(await checkScanRoots(databaseUrl));
  checks.push(await checkCacheDir(cacheDir));
  checks.push(await checkProviders(databaseUrl, offline, timeoutMs));
  checks.push(await checkAppSecret(databaseUrl));

  // Determine if all checks passed (warnings are not failures)
  const ok = checks.every((c) => c.status !== 'fail');

  return { ok, checks };
}
