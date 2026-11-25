#!/usr/bin/env node
/**
 * The module runs for installs without the updater service:
 * install-tagave.sh enable-module / disable-module start this image as a
 * one-off container (Docker socket and install folder mounted, on the
 * install's default network so it reaches the app) and run
 *
 *   node dist/cli.js module enable <id> [--manifest FILE --signature FILE]
 *   node dist/cli.js module disable <id> [--delete-data [--delete-history]]
 *
 * The same state machine and the same checks as Settings › Modules: only a
 * module from the signed catalogue of the release that runs here. The
 * manifest is the one next to the install, or the files given (kept there
 * once they check out). Every log line is printed; the exit code is 0 when
 * the run succeeded.
 *
 *   node dist/cli.js repair [--wait MINUTES]
 *
 * install-tagave.sh repair runs the same repair as Settings › Updates ›
 * Repair (trigger installer), saved to .updater/repair.json. It prints each
 * log line, then the headline. Exit 0 repaired, 4 waiting on the music share,
 * 5 needs you, 1 failed or refused, 2 bad arguments. A waiting repair is left
 * waiting in repair.json, where the updater service (when installed) takes it
 * over; --wait keeps watching here up to MINUTES (1 to 120) first.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RepairRun } from '@tagave/shared/updater';
import { DEFAULT_CONFIG } from './update.js';
import { dockerRunner, httpAppProbe, httpRepairReport } from './runner.js';
import { UpdaterService } from './server.js';
import { IMAGE_KEYS_DIR, loadTrustedKeys } from './release.js';
import { envGet, readText } from './envFile.js';
import { MusicHealer, httpMusicApp, type MusicApp } from './music-heal.js';
import { cachedProber, musicProber } from './music-probe.js';
import { USAGE, parseRepairArgs, repairExitCode } from './cli-args.js';

/** Only the app's health is asked for with it; nothing is signed with it. */
const UNUSED_SECRET = 'unused-by-module-runs';

function usage(): never {
  console.error(USAGE);
  process.exit(2);
}

function installDirOf(): string {
  const installDir = process.env['TAGAVE_INSTALL_DIR'];
  if (!installDir || !installDir.startsWith('/')) throw new Error('TAGAVE_INSTALL_DIR must be the absolute path of the install folder');
  return installDir;
}

function appUrlOf(): string {
  return process.env['TAGAVE_UPDATER_APP_URL'] || 'http://app:3000';
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args[0] === 'repair') return repair(args.slice(1));
  if (args[0] !== 'module' || (args[1] !== 'enable' && args[1] !== 'disable') || !args[2]) usage();
  const action = args[1];
  const id = args[2];
  const opt = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const installDir = installDirOf();
  const keys = await loadTrustedKeys(IMAGE_KEYS_DIR);
  const service = new UpdaterService({
    installDir,
    appSecret: UNUSED_SECRET,
    version: process.env['TAGAVE_BUILD_VERSION'] || 'unknown',
    keys,
    docker: dockerRunner(installDir),
    app: httpAppProbe(appUrlOf(), UNUSED_SECRET),
    config: { ...DEFAULT_CONFIG, selfUpdate: false },
  });
  const manifest = opt('--manifest');
  if (manifest) {
    const sigFile = opt('--signature');
    const accepted = await service.acceptRelease(await readFile(manifest, 'utf8'), sigFile ? await readFile(sigFile, 'utf8') : '');
    if (!accepted.ok) {
      console.error(`refused: ${accepted.error}`);
      return 1;
    }
  }
  const deleteData = args.includes('--delete-data');
  const deleteHistory = args.includes('--delete-history') || args.includes('--delete-play-history');
  if (deleteHistory && !deleteData) {
    console.error('refused: --delete-history goes with --delete-data');
    return 2;
  }
  const started = await service.startModule(id, action, deleteData, deleteHistory);
  if (!started.ok) {
    console.error(`refused: ${started.error}`);
    return 1;
  }
  let printed = 0;
  const flush = async () => {
    const run = (await service.modules()).run;
    for (const line of run?.log.slice(printed) ?? []) console.log(`${line.level === 'info' ? '  ' : `${line.level}: `}${line.message}`);
    printed = run?.log.length ?? printed;
    return run;
  };
  const timer = setInterval(() => void flush(), 1000);
  await service.idle();
  clearInterval(timer);
  const run = await flush();
  if (run?.status !== 'succeeded') {
    console.error(`${run?.moduleName ?? id}: ${run?.status ?? 'unknown'}: ${run?.reason ?? ''}`);
    return 1;
  }
  if (run.reason) console.error(run.reason);
  return 0;
}

/**
 * The same repair as the Repair button, through the same service: its claim,
 * repair.json, the one-hour "running elsewhere" rule and the healer's remount
 * (no healer timer here, and no repair.json timer).
 */
async function repair(args: string[]): Promise<number> {
  const parsed = parseRepairArgs(args);
  if (!parsed.ok) usage();
  const installDir = installDirOf();
  const appUrl = appUrlOf();
  // The app's signed calls (its music check, the audit entry) need APP_SECRET, read from .env only.
  const appSecret = envGet((await readText(join(installDir, '.env'))) ?? '', 'APP_SECRET') || null;
  const docker = dockerRunner(installDir);
  const music = cachedProber(musicProber({ installDir, docker }), Date.now);
  const musicApp: MusicApp = appSecret ? httpMusicApp(appUrl, appSecret) : { unmounted: async () => null, report: async () => undefined };
  const service = new UpdaterService({
    installDir,
    appSecret: appSecret ?? UNUSED_SECRET,
    version: process.env['TAGAVE_BUILD_VERSION'] || 'unknown',
    // A repair installs nothing: no release key is needed.
    keys: [],
    docker,
    app: httpAppProbe(appUrl, appSecret ?? UNUSED_SECRET),
    config: { ...DEFAULT_CONFIG, selfUpdate: false },
    music,
    ...(appSecret ? { musicUnmounted: () => musicApp.unmounted(), report: httpRepairReport(appUrl, appSecret) } : {}),
  });
  service.attachHealer(new MusicHealer({
    installDir,
    docker,
    music,
    app: musicApp,
    busy: () => service.moving(),
    updating: () => service.updating(),
  }));
  const started = await service.startRepair('installer');
  if (!started.ok) {
    console.error(started.error === 'a repair is running' ? 'A repair is already running' : `refused: ${started.error}`);
    return 1;
  }
  const run: RepairRun = started.run;
  let printed = 0;
  const flush = () => {
    for (const line of run.log.slice(printed)) console.log(`${line.level === 'info' ? '  ' : `${line.level}: `}${line.message}`);
    printed = run.log.length;
  };
  const timer = setInterval(flush, 1000);
  await service.idle();
  if (run.status === 'waiting' && parsed.waitMinutes !== null) await service.waitForRepair(parsed.waitMinutes * 60_000);
  clearInterval(timer);
  // Still waiting: the watcher stops and the run stays waiting in repair.json.
  service.stop();
  flush();
  const code = repairExitCode(run.status);
  const headline = run.headline ?? `${run.status}${run.reason ? `: ${run.reason}` : ''}`;
  if (code === 0 || code === 4) console.log(headline);
  else console.error(headline);
  return code;
}

main().then((code) => process.exit(code), (err: unknown) => {
  console.error((err as Error).message);
  process.exit(1);
});
