import { describe, expect, it } from 'vitest';
import type { RepairStatus } from '@tagave/shared/updater';
import { USAGE, parseRepairArgs, repairExitCode } from './cli-args.js';

describe('cli.js repair', () => {
  it('maps how the repair ended to the exit code', () => {
    const table: Array<[RepairStatus, number]> = [['repaired', 0], ['waiting', 4], ['needs_you', 5], ['failed', 1], ['running', 1]];
    for (const [status, code] of table) expect(repairExitCode(status)).toBe(code);
  });

  it('runs without --wait, or with --wait 1 to 120', () => {
    expect(parseRepairArgs([])).toEqual({ ok: true, waitMinutes: null });
    expect(parseRepairArgs(['--wait', '1'])).toEqual({ ok: true, waitMinutes: 1 });
    expect(parseRepairArgs(['--wait', '120'])).toEqual({ ok: true, waitMinutes: 120 });
  });

  it('refuses a missing or bad --wait value, and anything else', () => {
    for (const args of [['--wait'], ['--wait', '0'], ['--wait', '121'], ['--wait', 'abc'], ['--wait', '1.5'], ['--wait', '-5'], ['--wait', ''], ['--other'], ['--wait', '5', 'extra']]) {
      expect(parseRepairArgs(args), args.join(' ')).toEqual({ ok: false });
    }
  });

  it('the usage names both commands', () => {
    expect(USAGE).toBe('usage: cli.js module enable|disable <id> [--delete-data [--delete-history]] [--manifest FILE --signature FILE]\n       cli.js repair [--wait MINUTES]');
  });
});
