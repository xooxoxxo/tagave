/** The pure parts of cli.js: its usage, the repair's arguments and exit codes (kept apart so tests import them without running the CLI). */
import type { RepairStatus } from '@tagave/shared/updater';
import type { Runner } from './runner.js';

export const USAGE = [
  'usage: cli.js module enable|disable <id> [--delete-data [--delete-history]] [--manifest FILE --signature FILE]',
  '       cli.js repair [--wait MINUTES]',
].join('\n');

/** The longest `--wait`, in minutes. */
export const MAX_WAIT_MINUTES = 120;

/** `repair [--wait MINUTES]`: the arguments after `repair`. Anything else is a usage error (exit 2). */
export function parseRepairArgs(args: string[]): { ok: true; waitMinutes: number | null } | { ok: false } {
  if (args.length === 0) return { ok: true, waitMinutes: null };
  if (args.length !== 2 || args[0] !== '--wait' || !/^[0-9]{1,3}$/.test(args[1]!)) return { ok: false };
  const minutes = Number(args[1]);
  return minutes >= 1 && minutes <= MAX_WAIT_MINUTES ? { ok: true, waitMinutes: minutes } : { ok: false };
}

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

/**
 * The headline as cli.js prints it: the saved one (the web shows it), but
 * when this install's updater service does not run, nothing finishes a
 * waiting run on its own and there is no Repair button to press.
 */
export function printedHeadline(status: RepairStatus, headline: string, updaterRuns: boolean): string {
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
