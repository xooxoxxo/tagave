/** The pure parts of cli.js: its usage, the repair's arguments and exit codes (kept apart so tests import them without running the CLI). */
import type { RepairStatus } from '@tagave/shared/updater';

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
