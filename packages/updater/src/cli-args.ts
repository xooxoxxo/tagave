/** The testable parts of cli.js: its usage, the repair's arguments and exit codes, the music-layout command (kept apart so tests import them without running the CLI). */
import { join } from 'node:path';
import type { RepairStatus } from '@tagave/shared/updater';
import { readText } from './envFile.js';
import { hasParentLayout, layoutReason, moveLayout, planLayout } from './music-layout.js';
import { RepairLock } from './repair-lock.js';
import type { Runner } from './runner.js';

export const USAGE = [
  'usage: cli.js module enable|disable <id> [--delete-data [--delete-history]] [--manifest FILE --signature FILE]',
  '       cli.js repair [--wait MINUTES]',
  '       cli.js music-layout [--apply]',
].join('\n');

/** `music-layout [--apply]`: the arguments after `music-layout`. Anything else is a usage error (exit 2). */
export function parseLayoutArgs(args: string[]): { ok: true; apply: boolean } | { ok: false } {
  if (args.length === 0) return { ok: true, apply: false };
  return args.length === 1 && args[0] === '--apply' ? { ok: true, apply: true } : { ok: false };
}

const ALREADY_PARENT = 'the music share already uses the parent layout: nothing to do';
const DRY_RUN_END = 'Nothing was changed. Run it again with --apply to write these settings and start the music parts on them.';
/** --apply while the repair lock is held (cli.js repair, the Repair button or a self-heal). */
export const REPAIR_UNDER_WAY = 'another repair is under way; run it again later';
const STAYS_NO_MUSIC = `the music share stays on the direct layout: ${layoutReason('no_music_dir')}`;

/**
 * `cli.js music-layout [--apply]`. Without --apply: the decision and its
 * reason, and the .env lines it would write; nothing is written or started
 * (the host is read, as the move reads it); no lock is taken. With --apply:
 * the repair lock (holder 'repair', as cli.js repair takes it), then
 * moveLayout, its log lines printed; when the lock is held, it says so and
 * changes nothing. 0 when it moved, had nothing to do, was refused with a
 * reason or found a repair under way; 1 on an error.
 */
export async function layoutCommand(apply: boolean, deps: {
  installDir: string;
  docker: Runner;
  image: () => Promise<string | null>;
  out: (line: string) => void;
  err: (line: string) => void;
}): Promise<0 | 1> {
  try {
    const env = await readText(join(deps.installDir, '.env'));
    if (env === null) throw new Error(`there is no .env in ${deps.installDir}`);
    if (hasParentLayout(env)) {
      deps.out(`  ${ALREADY_PARENT}`);
      return 0;
    }
    if (apply) {
      // The move changes .env and starts parts: never while a repair or a self-heal runs (cli.js repair takes the same lock).
      const lock = await new RepairLock({ installDir: deps.installDir }).acquire('repair');
      if (!lock.ok && lock.holder !== null) {
        deps.out(`  ${REPAIR_UNDER_WAY}`);
        return 0;
      }
      try {
        const res = await moveLayout({ installDir: deps.installDir, docker: deps.docker, image: deps.image, log: (l, m) => (l === 'info' ? deps.out(`  ${m}`) : deps.err(`warn: ${m}`)) });
        // planLayout logs no line for an app computer; the command still says why nothing moved.
        if (res.why === 'no_music_dir') deps.out(`  ${STAYS_NO_MUSIC}`);
      } finally {
        if (lock.ok) await lock.release();
      }
      return 0;
    }
    const plan = await planLayout({ env, docker: deps.docker, image: deps.image, installDir: deps.installDir });
    if (plan.message) deps.out(`  ${plan.message}`);
    else if (plan.why === 'no_music_dir') deps.out(`  ${STAYS_NO_MUSIC}`);
    if (plan.moved) {
      const before = new Set(env.split('\n'));
      for (const line of plan.env.split('\n')) if (line !== '' && !before.has(line)) deps.out(`  ${line}`);
      deps.out(DRY_RUN_END);
    }
    return 0;
  } catch (err) {
    deps.err((err as Error)?.message ?? String(err));
    return 1;
  }
}

/** The longest `--wait`, in minutes. */
export const MAX_WAIT_MINUTES = 120;

/** `repair [--wait MINUTES]`: the arguments after `repair`. Anything else is a usage error (exit 2). */
export function parseRepairArgs(args: string[]): { ok: true; waitMinutes: number | null } | { ok: false } {
  if (args.length === 0) return { ok: true, waitMinutes: null };
  if (args.length !== 2 || args[0] !== '--wait' || !/^[0-9]{1,3}$/.test(args[1]!)) return { ok: false };
  const minutes = Number(args[1]);
  return minutes >= 1 && minutes <= MAX_WAIT_MINUTES ? { ok: true, waitMinutes: minutes } : { ok: false };
}

/** A repair or a self-heal of this install runs in another process (or this one): nothing else starts. */
export const ALREADY_RUNNING = 'A repair is already running. Wait for it to end, then run the installer again with --repair if a part still does not run.';

/** Printed instead of watching when --wait is given and the updater service runs here. */
export const WAIT_NOT_NEEDED = 'The updater keeps watching the music share, so --wait is not needed here.';

/** This install's updater service runs (one call, 10 s): its watcher takes a waiting repair over. A failed or slow call says no. */
export async function updaterServiceRuns(docker: Runner): Promise<boolean> {
  const res = await docker(['compose', 'ps', '-q', 'updater'], { timeoutMs: 10_000 }).catch(() => null);
  return res?.code === 0 && res.stdout.trim() !== '';
}

/** How a waiting headline ends: the updater service's watcher finishes the run (repair.ts). */
const SERVICE_FINISHES = "tagave finishes on its own when it's back.";
/** Its ending when no updater service runs here: the one-off container watches no longer. */
export const INSTALLER_AGAIN = "Run the installer again once it's back.";

/** What a failed run says to run instead of pressing Repair again: the terminal has no button. */
export const RUN_AGAIN = 'Run the installer again with --repair';

/**
 * The headline as cli.js prints it: the saved one (the web shows it), but a
 * failed run's "Press Repair again" names the installer (it was run from the
 * terminal), and when this install's updater service does not run, nothing
 * finishes a waiting run on its own and there is no Repair button to press.
 */
export function printedHeadline(status: RepairStatus, headline: string, updaterRuns: boolean): string {
  if (status === 'failed') return headline.replaceAll('Press Repair again', RUN_AGAIN);
  if (updaterRuns) return headline;
  if (status === 'waiting' && headline.endsWith(SERVICE_FINISHES)) return `${headline.slice(0, -SERVICE_FINISHES.length)}${INSTALLER_AGAIN}`;
  if (status === 'needs_you') return headline.replaceAll('press Repair', 'run the installer again with --repair');
  return headline;
}

/** 0 repaired, 4 waiting on the music share, 5 needs the owner, 1 failed (or, never expected, still running). */
export function repairExitCode(status: RepairStatus): 0 | 1 | 4 | 5 {
  switch (status) {
    case 'repaired': return 0;
    case 'waiting': return 4;
    case 'needs_you': return 5;
    case 'failed':
    case 'running': return 1;
  }
}
