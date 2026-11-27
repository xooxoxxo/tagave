import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RepairStatus } from '@tagave/shared/updater';
import { assertAllowed } from './argv-guard.testkit.js';
import { ALREADY_RUNNING, USAGE, layoutCommand, parseLayoutArgs, printedHeadline, parseRepairArgs, repairExitCode, updaterServiceRuns } from './cli-args.js';
import { repairHeadline } from './repair.js';
import { STOPPED_REPAIR } from './server.js';
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

  describe('the printed headline', () => {
    const waiting = repairHeadline({ status: 'waiting', outcome: { cause: 'music_unreachable', service: 'worker-files', server: '192.0.2.10', partsTotal: 5, partsRunning: 4 } });

    it('waiting, with the updater service: as saved, the service finishes it', () => {
      expect(printedHeadline('waiting', waiting, true)).toBe("Your music share at 192.0.2.10 doesn't answer. Turn the NAS on or check its cable. tagave finishes on its own when it's back.");
    });

    it('waiting, without it: run the installer again, never the promise', () => {
      expect(printedHeadline('waiting', waiting, false)).toBe("Your music share at 192.0.2.10 doesn't answer. Turn the NAS on or check its cable. Run the installer again once it's back.");
    });

    it('needs you, without the updater service: the installer, not the Repair button', () => {
      const oom = 'The file worker ran out of memory. Close other programs on this computer, then press Repair.';
      const notConnected = "Your music folder isn't connected, and tagave can't connect it for you. Connect the drive or share, then press Repair.";
      expect(printedHeadline('needs_you', oom, false)).toBe('The file worker ran out of memory. Close other programs on this computer, then run the installer again with --repair.');
      expect(printedHeadline('needs_you', notConnected, false)).toBe("Your music folder isn't connected, and tagave can't connect it for you. Connect the drive or share, then run the installer again with --repair.");
      expect(printedHeadline('needs_you', oom, true)).toBe(oom);
    });

    it('failed: what to run in the terminal, never a button to press', () => {
      const saved = [
        'The repair stopped. Press Repair again.',
        'The updater restarted during the repair. Press Repair again.',
        'Another change is under way. Press Repair again when it ends.',
        'The web app is still busy (backing up the database). Press Repair again when it is done.',
      ];
      const printed = [
        'The repair stopped. Run the installer again with --repair.',
        'The updater restarted during the repair. Run the installer again with --repair.',
        'Another change is under way. Run the installer again with --repair when it ends.',
        'The web app is still busy (backing up the database). Run the installer again with --repair when it is done.',
      ];
      for (const runs of [false, true]) {
        expect(saved.map((h) => printedHeadline('failed', h, runs))).toEqual(printed);
      }
      for (const line of printed) {
        expect(line).not.toMatch(/press|button|\u2014/i);
        expect(line.length).toBeLessThan(300);
      }
      expect(printedHeadline('failed', 'The repair could not finish. The run log says why.', false)).toBe('The repair could not finish. The run log says why.');
    });

    it('the stop on Ctrl-C names the installer', () => {
      expect(printedHeadline('failed', STOPPED_REPAIR, true)).toBe('The repair stopped. Run the installer again with --repair.');
    });

    it('any other end is printed as saved', () => {
      expect(printedHeadline('repaired', 'Repaired. All 5 parts running.', false)).toBe('Repaired. All 5 parts running.');
    });
  });

  it('a second repair is told one is already running, in plain words', () => {
    expect(ALREADY_RUNNING).toBe('A repair is already running. Wait for it to end, then run the installer again with --repair if a part still does not run.');
    expect(ALREADY_RUNNING).not.toMatch(/\u2014/);
  });

  it('the usage names every command', () => {
    expect(USAGE).toBe('usage: cli.js module enable|disable <id> [--delete-data [--delete-history]] [--manifest FILE --signature FILE]\n       cli.js repair [--wait MINUTES]\n       cli.js music-layout [--apply]');
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

describe('cli.js music-layout', () => {
  const IMAGE = `sha256:${'d'.repeat(64)}`;
  const ENV = 'COMPOSE_PROJECT_NAME=tagave\nTAGAVE_ROLE=all\nMUSIC_DIR=/mnt/music\nTAGAVE_MUSIC_MODE=rw\n';
  let dir: string;
  let out: string[];
  let err: string[];
  let calls: string[][];

  /** A host where /mnt/music is an NFS mount in a shared /mnt that holds nothing else, and compose that starts what it is asked. */
  const docker: Runner = async (args) => {
    assertAllowed(args);
    calls.push(args);
    const ok = (stdout = ''): CommandResult => ({ code: 0, stdout, stderr: '' });
    if (args[0] === 'info') return ok('linux\nUbuntu 24.04.1 LTS\n/var/lib/docker\nname=seccomp \n');
    if (args[0] === 'run') {
      const command = args.slice(args.indexOf('--') + 1).join(' ');
      if (command === 'cat /proc/self/mountinfo') return ok('22 1 8:1 / / rw shared:1 - ext4 /dev/sda1 rw\n60 22 0:60 / /mnt/music rw shared:60 - nfs4 192.0.2.10:/export/music rw,hard\n');
      if (command === 'cat /etc/fstab') return ok('');
      if (command.startsWith('findmnt')) return ok('shared\n');
      if (command.startsWith('sh -c')) return ok('music\n');
    }
    if (args.join(' ') === 'compose config --services') return ok('postgres\napp\nworker-identify\nworker-files\nplayer\nupdater\n');
    if (args[0] === 'compose' && args[1] === 'up') return ok();
    if (args[0] === 'compose' && args[1] === 'ps') return ok(`${Buffer.from(args.at(-1)!).toString('hex').padEnd(12, '0')}\n`);
    if (args[0] === 'inspect') return ok('running\n');
    return { code: 1, stdout: '', stderr: `unexpected: ${args.join(' ')}` };
  };
  const run = (apply: boolean) => layoutCommand(apply, { installDir: dir, docker, image: async () => IMAGE, out: (l) => out.push(l), err: (l) => err.push(l) });
  const envText = () => readFile(join(dir, '.env'), 'utf8');

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tagave-cli-layout-'));
    out = [];
    err = [];
    calls = [];
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('takes no argument or --apply, nothing else', () => {
    expect(parseLayoutArgs([])).toEqual({ ok: true, apply: false });
    expect(parseLayoutArgs(['--apply'])).toEqual({ ok: true, apply: true });
    for (const args of [['--apply', '--apply'], ['apply'], ['--dry-run'], ['--apply', 'x'], ['']]) expect(parseLayoutArgs(args), args.join(' ')).toEqual({ ok: false });
  });

  it('without --apply: says what it would do and changes nothing', async () => {
    await writeFile(join(dir, '.env'), ENV);
    expect(await run(false)).toBe(0);
    expect(await envText()).toBe(ENV);
    expect(calls.some((c) => c[0] === 'compose' && c[1] === 'up')).toBe(false);
    expect(out[0]).toMatch(/^the music share moves to the parent layout: /);
    expect(out).toContain('  TAGAVE_MUSIC_BIND_SOURCE=/mnt');
    expect(out.at(-1)).toBe('Nothing was changed. Run it again with --apply to write these settings and start the music parts on them.');
    for (const l of out) expect(l.includes(String.fromCharCode(0x2014))).toBe(false);
  });

  it('with --apply: moves, prints its log lines, exit 0', async () => {
    await writeFile(join(dir, '.env'), ENV);
    expect(await run(true)).toBe(0);
    expect(await envText()).toContain('TAGAVE_MUSIC_BIND_SOURCE=/mnt\n');
    expect(out.some((l) => l.startsWith('  the music share moves to the parent layout: '))).toBe(true);
    expect(calls.filter((c) => c[0] === 'compose' && c[1] === 'up').map((c) => c.at(-1))).toEqual(['worker-files', 'player']);
    // a second run has nothing to do
    out = [];
    expect(await run(true)).toBe(0);
    expect(out).toEqual(['  the music share already uses the parent layout: nothing to do']);
  });

  it('a refusal is exit 0 with its reason, and nothing changes', async () => {
    const ro = ENV.replace('TAGAVE_MUSIC_MODE=rw', 'TAGAVE_MUSIC_MODE=ro');
    await writeFile(join(dir, '.env'), ro);
    for (const apply of [false, true]) {
      out = [];
      expect(await run(apply)).toBe(0);
      expect(out.join('\n')).toContain('the music share stays on the direct layout: ');
    }
    expect(await envText()).toBe(ro);
    expect(calls).toEqual([]);
  });

  it('an error is exit 1: no .env', async () => {
    expect(await run(true)).toBe(1);
    expect(err.join('\n')).toMatch(/no \.env/);
    expect(await run(false)).toBe(1);
  });
});
