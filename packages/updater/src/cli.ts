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
 * 5 needs you, 1 failed, refused (a repair or self-heal already runs, here
 * or in the updater service: .updater/repair.lock) or stopped (SIGINT,
 * SIGTERM; the end is saved and told to the app before it exits), 2 bad
 * arguments. A waiting repair is left waiting in repair.json, where the
 * updater service (when installed) takes it over; --wait keeps watching here
 * up to MINUTES (1 to 120) first. Without that service the printed headline
 * names the installer instead of the service and the Repair button.
 *
 *   node dist/cli.js music-layout [--apply]
 *
 * The one-time move to the parent music layout (music-layout.ts), which
 * install-tagave.sh update runs from the target's updater image once the
 * update is healthy. Without --apply it prints the decision, its reason and
 * the .env lines it would write, and changes nothing. With --apply it writes
 * them and starts the music parts on them, printing each log line; it takes
 * the repair lock first, as repair does, and when a repair or a self-heal
 * holds it, says so and changes nothing. Exit 0 when it moved, had nothing
 * to do, was refused with a reason or found a repair under way; 1 on an
 * error; 2 bad arguments. It never reads what is in the music folder.
 */
import { readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import type { RepairRun } from '@tagave/shared/updater';
import { DEFAULT_CONFIG } from './update.js';
import { dockerRunner, httpAppProbe, httpRepairReport } from './runner.js';
import { STOPPED_REPAIR, UpdaterService } from './server.js';
import { IMAGE_KEYS_DIR, loadTrustedKeys } from './release.js';
import { envGet, readText } from './envFile.js';
import { MusicHealer, httpMusicApp, selfImage, type MusicApp } from './music-heal.js';
import { cachedProber, musicProber } from './music-probe.js';
import { ALREADY_RUNNING, USAGE, WAIT_NOT_NEEDED, layoutCommand, parseLayoutArgs, parseRepairArgs, printedHeadline, repairExitCode, updaterServiceRuns } from './cli-args.js';

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
  if (args[0] === 'music-layout') return musicLayout(args.slice(1));
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
    // The start step's one-time move to the parent music layout: helpers from this one-off's own image.
    layoutImage: () => selfImage(docker, hostname()),
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
    console.error(started.error === 'a repair is running' ? ALREADY_RUNNING : `refused: ${started.error}`);
    return 1;
  }
  const run: RepairRun = started.run;
  let printed = 0;
  const flush = () => {
    for (const line of run.log.slice(printed)) {
      // The headline is the last line printed, once.
      if (run.headline !== null && line.message === run.headline) continue;
      console.log(`${line.level === 'info' ? '  ' : `${line.level}: `}${line.message}`);
    }
    printed = run.log.length;
  };
  const timer = setInterval(flush, 1000);
  // Ctrl-C (or docker stopping the one-off) while it runs: the run ends
  // failed and saved, never left "running" in repair.json for the hour other
  // starts wait. A waiting run stays waiting.
  const onSignal = () => {
    clearInterval(timer);
    void (async () => {
      const wasRunning = run.status === 'running';
      await service.interruptRepair().catch(() => undefined);
      service.stop();
      await service.repairSaved().catch(() => undefined);
      flush();
      if (wasRunning) console.error(printedHeadline('failed', STOPPED_REPAIR, false));
      process.exit(wasRunning ? 1 : repairExitCode(run.status));
    })();
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  await service.idle();
  // One call, 10 s: whether this install's updater service takes a waiting
  // run over and has the Repair button. It decides --wait and the headline's ending.
  const serviceRuns = await updaterServiceRuns(docker);
  if (run.status === 'waiting' && parsed.waitMinutes !== null) {
    // The service's watcher takes the run over: one watcher per run.
    if (serviceRuns) {
      flush();
      console.log(WAIT_NOT_NEEDED);
    } else {
      await service.waitForRepair(parsed.waitMinutes * 60_000);
    }
  }
  clearInterval(timer);
  // Still waiting: the watcher stops and the run stays waiting in repair.json, fully written before the exit.
  service.stop();
  await service.repairSaved();
  flush();
  const code = repairExitCode(run.status);
  const headline = run.headline !== null
    ? printedHeadline(run.status, run.headline, serviceRuns)
    : `${run.status}${run.reason ? `: ${run.reason}` : ''}`;
  if (code === 0 || code === 4) console.log(headline);
  else console.error(headline);
  return code;
}

/** The one-time move to the parent music layout; its helpers run from this one-off's own image. */
async function musicLayout(args: string[]): Promise<number> {
  const parsed = parseLayoutArgs(args);
  if (!parsed.ok) usage();
  const installDir = installDirOf();
  const docker = dockerRunner(installDir);
  return layoutCommand(parsed.apply, {
    installDir,
    docker,
    image: () => selfImage(docker, hostname()),
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  });
}

main().then((code) => process.exit(code), (err: unknown) => {
  console.error((err as Error).message);
  process.exit(1);
});
