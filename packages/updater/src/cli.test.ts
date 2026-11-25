import { describe, expect, it } from 'vitest';
import type { RepairStatus } from '@tagave/shared/updater';
import { assertAllowed } from './argv-guard.testkit.js';
import { USAGE, parseRepairArgs, repairExitCode, updaterServiceRuns } from './cli-args.js';
import type { CommandResult, Runner } from './runner.js';

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

  describe('the updater service runs here (then --wait is not needed)', () => {
    const fake = (answer: Partial<CommandResult> | Error) => {
      const calls: Array<{ args: string[]; timeoutMs: number | undefined }> = [];
      const docker: Runner = async (args, opts) => {
        assertAllowed(args);
        calls.push({ args, timeoutMs: opts?.timeoutMs });
        if (answer instanceof Error) throw answer;
        return { code: 0, stdout: '', stderr: '', ...answer };
      };
      return { docker, calls };
    };

    it('asks compose for the running updater once, within 10 s', async () => {
      const f = fake({ stdout: '3f2a9c1b7d4e\n' });
      expect(await updaterServiceRuns(f.docker)).toBe(true);
      expect(f.calls).toEqual([{ args: ['compose', 'ps', '-q', 'updater'], timeoutMs: 10_000 }]);
    });

    it('no id, a failed call or a timeout keeps --wait', async () => {
      expect(await updaterServiceRuns(fake({ stdout: '\n' }).docker)).toBe(false);
      expect(await updaterServiceRuns(fake({ code: 1, stderr: 'no such service: updater' }).docker)).toBe(false);
      expect(await updaterServiceRuns(fake({ code: 1, stderr: 'timed out after 10 s' }).docker)).toBe(false);
      expect(await updaterServiceRuns(fake(new Error('spawn docker ENOENT')).docker)).toBe(false);
    });
  });
});
