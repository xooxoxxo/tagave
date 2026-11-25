/**
 * The repair state machine on a fake Docker with its own clock: a call that
 * times out moves the clock on by its limit, and the injected sleep moves it
 * on by what it was asked to wait. One test per row of the spec's cause table.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RepairCause, RepairRun } from '@tagave/shared/updater';
import { assertAllowed } from './argv-guard.testkit.js';
import { musicVerdict, type MusicProber, type MusicReading, type ServerAnswer } from './music-probe.js';
import type { RemountResult } from './music-heal.js';
import { INSPECT_FORMAT } from './progress.js';
import { REPAIR_STATE_FILE, Repair, newRepairRun, repairHeadline, type RepairConfig, type RepairDeps } from './repair.js';
import type { AppProbe, CommandResult, Runner } from './runner.js';

const SERVICES = ['postgres', 'app', 'worker-identify', 'worker-files', 'player'];
const MB = 1024 ** 2;

interface Box {
  status: string;
  health?: string | null;
  oom?: boolean;
  exitCode?: number;
  restarts?: number;
  error?: string;
  logs?: string | (() => string);
  /** compose stop and kill time out */
  stopHangs?: boolean;
  /** what `compose up` does to it; running by default */
  up?: (b: Box, recreate: boolean) => void;
}

const id = (svc: string) => Buffer.from(svc).toString('hex').padEnd(12, '0');
const serviceOf = (cid: string) => SERVICES.find((s) => id(s) === cid)!;
const running = (): Box => ({ status: 'running' });

class Fake {
  clock = Date.parse('2026-11-25T10:00:00Z');
  calls: string[][] = [];
  boxes = new Map<string, Box>(SERVICES.map((s) => [s, running()]));
  dockerAnswers = true;
  freeBytes = 20 * 1024 ** 3;
  appRestarts = 0;
  /** What `compose restart app` exits with. */
  restartCode = 0;
  onAppRestart: () => void = () => {};
  healthy: () => boolean = () => true;
  share: ServerAnswer = 'answers';
  mount: MusicReading['mount'] = { kind: 'network', fstype: 'nfs4', server: '192.0.2.10', export: '/music', hard: true, mountPoint: '/mnt/music' };
  appUnmounted: boolean | null = false;
  reads = 0;
  sleeps: number[] = [];
  /** Told after each sleep, with how many there were so far. */
  onSleep: (count: number) => void = () => {};
  saved: RepairRun[] = [];
  reports: Array<{ status: string; cause: string | null }> = [];
  remounts: Array<[string, string]> = [];
  remountResult: RemountResult = 'mounted';

  box(s: string): Box {
    return this.boxes.get(s)!;
  }

  docker: Runner = async (args, opts) => {
    assertAllowed(args);
    this.calls.push(args);
    const a = this.answer(args);
    if (a === 'timeout') {
      this.clock += opts?.timeoutMs ?? 0;
      return { code: 143, stdout: '', stderr: `timed out after ${Math.round((opts?.timeoutMs ?? 0) / 1000)} s` };
    }
    return { code: 0, stdout: '', stderr: '', ...a };
  };

  private answer(a: string[]): Partial<CommandResult> | 'timeout' {
    if (a[0] === 'version') return this.dockerAnswers ? { stdout: '28.0.0\n' } : 'timeout';
    if (a[0] === 'compose' && a[1] === 'config' && a[2] === '--services') return { stdout: `${SERVICES.join('\n')}\nupdater\n` };
    if (a[0] === 'compose' && a[1] === 'ps') {
      const b = this.box(a.at(-1)!);
      return { stdout: b.status === 'none' ? '' : `${id(a.at(-1)!)}\n` };
    }
    if (a[0] === 'inspect') {
      const b = this.box(serviceOf(a.at(-1)!));
      if (b.status === 'none') return { code: 1, stderr: 'Error: No such object' };
      if (a[2] === '{{.State.Status}}') return { stdout: `${b.status}\n` };
      if (a[2] === INSPECT_FORMAT) {
        const state = { Status: b.status, Restarting: b.status === 'restarting', OOMKilled: b.oom === true, ExitCode: b.exitCode ?? 0, Error: b.error ?? '', Health: b.health ? { Status: b.health } : null };
        return { stdout: `${JSON.stringify(state)}|${b.restarts ?? 0}\n` };
      }
      return { stdout: `${b.status}|${b.health ?? ''}\n` };
    }
    if (a[0] === 'logs') {
      const b = this.box(serviceOf(a.at(-1)!));
      return { stdout: typeof b.logs === 'function' ? b.logs() : (b.logs ?? '') };
    }
    if (a[0] === 'compose' && a[1] === 'stop') {
      const b = this.box(a.at(-1)!);
      if (b.stopHangs) return 'timeout';
      b.status = 'exited';
      return {};
    }
    if (a[0] === 'kill') {
      const b = this.box(serviceOf(a[1]!));
      if (b.stopHangs) return 'timeout';
      b.status = 'exited';
      return {};
    }
    if (a[0] === 'compose' && a[1] === 'up') {
      const b = this.box(a.at(-1)!);
      const recreate = a.includes('--force-recreate');
      if (b.up) b.up(b, recreate);
      else Object.assign(b, { status: 'running', oom: false, exitCode: 0 });
      return {};
    }
    if (a[0] === 'compose' && a[1] === 'restart' && a[2] === 'app') {
      this.appRestarts++;
      if (this.restartCode !== 0) return { code: this.restartCode, stderr: 'Error response from daemon' };
      this.onAppRestart();
      return {};
    }
    return { code: 1, stderr: `unexpected: ${a.join(' ')}` };
  }

  app: AppProbe = {
    health: async () => (this.healthy() ? { ok: true, detail: 'ok' } : { ok: false, detail: 'the app does not answer' }),
    versions: async () => (this.healthy() ? { app: '0.9.0', workers: [] } : null),
  };

  music: MusicProber = {
    read: async ({ parts, appUnmounted }) => {
      this.reads++;
      const answer = this.mount.kind === 'network' ? this.share : null;
      return { dir: '/mnt/music', mount: this.mount, answer, verdict: musicVerdict(this.mount, answer, parts, appUnmounted), server: this.mount.server };
    },
  };

  /** Calls that change a part (stop, kill, up, restart). */
  changes(): string[][] {
    return this.calls.filter((c) => c[0] === 'kill' || (c[0] === 'compose' && ['stop', 'up', 'restart'].includes(c[1]!)));
  }
}

let dir: string;
let fake: Fake;

const CONFIG: RepairConfig = { healthTimeoutMs: 5 * 60_000, pollMs: 3000, waitFirstMs: 60_000, waitMaxMs: 300_000, diskFullBytes: 256 * MB };

function deps(over: Partial<RepairDeps> = {}): RepairDeps {
  return {
    installDir: dir,
    docker: fake.docker,
    app: fake.app,
    music: fake.music,
    musicUnmounted: async () => fake.appUnmounted,
    healer: {
      remount: async (d, p) => {
        fake.remounts.push([d, p]);
        return fake.remountResult;
      },
    },
    report: async (end) => { fake.reports.push(end); },
    save: async (run) => { fake.saved.push(structuredClone(run)); },
    config: CONFIG,
    now: () => new Date(fake.clock),
    sleep: async (ms) => { fake.sleeps.push(ms); fake.clock += ms; fake.onSleep(fake.sleeps.length); },
    statfs: async () => ({ bavail: fake.freeBytes / 4096, bsize: 4096, blocks: 1e9 }),
    ...over,
  };
}

function repair(over: Partial<RepairDeps> = {}): Repair {
  return new Repair(deps(over), newRepairRun('repair-1', 'owner', new Date(fake.clock)));
}

const stepStatus = (run: RepairRun) => Object.fromEntries(run.steps.map((s) => [s.id, s.status]));

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tagave-repair-'));
  await writeFile(join(dir, '.env'), 'COMPOSE_PROJECT_NAME=tagave\nMUSIC_DIR=/mnt/music\n', { mode: 0o600 });
  fake = new Fake();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('repair', () => {
  it('nothing wrong: All 5 parts running. Nothing to repair.', async () => {
    const run = await repair().execute();
    expect(run.status).toBe('repaired');
    expect(run.headline).toBe('All 5 parts running. Nothing to repair.');
    expect(run.outcome).toEqual({ cause: null, service: null, server: null, partsRunning: 5, partsTotal: 5 });
    expect(stepStatus(run)).toEqual({ check: 'done', stop: 'skipped', music: 'skipped', start: 'skipped', verify: 'done' });
    expect(run.details).toEqual(['5 of 5 parts running.']);
    expect(run.finishedAt).not.toBeNull();
    expect(fake.changes()).toEqual([]);
    expect(fake.calls[0]).toEqual(['version', '--format', '{{.Server.Version}}']);
    expect(fake.reports).toEqual([{ status: 'repaired', cause: null }]);
    expect(fake.saved.at(-1)?.status).toBe('repaired');
  });

  it('a missing part is started: Repaired. All 5 parts running.', async () => {
    fake.box('player').status = 'none';
    const run = await repair().execute();
    expect(run.status).toBe('repaired');
    expect(run.headline).toBe('Repaired. All 5 parts running.');
    expect(run.outcome?.cause).toBe('missing');
    expect(run.details).toEqual(['Started the player.', '5 of 5 parts running.']);
    expect(fake.changes()).toEqual([['compose', 'up', '-d', '--no-deps', 'player']]);
  });

  it('music_unmounted, remounted: Music share was not connected. Connected it again. All 5 parts running.', async () => {
    fake.mount = { kind: 'absent', fstype: 'ext4', server: null, export: null, hard: false, mountPoint: '/' };
    fake.appUnmounted = true;
    const run = await repair().execute();
    expect(fake.remounts).toEqual([['/mnt/music', 'tagave']]);
    expect(run.status).toBe('repaired');
    expect(run.headline).toBe('Music share was not connected. Connected it again. All 5 parts running.');
    expect(run.outcome?.cause).toBe('music_unmounted');
    expect(run.details).toContain('Connected the music share again.');
  });

  it('not_in_fstab: needs_you with its headline', async () => {
    fake.mount = { kind: 'absent', fstype: 'ext4', server: null, export: null, hard: false, mountPoint: '/' };
    fake.appUnmounted = true;
    fake.remountResult = 'not_in_fstab';
    const run = await repair().execute();
    expect(run.status).toBe('needs_you');
    expect(run.outcome?.cause).toBe('not_in_fstab');
    expect(run.headline).toBe("Your music folder isn't connected, and tagave can't connect it for you. Connect the drive or share, then press Repair.");
    expect(run.details).toContain("tagave only connects shares listed in the computer's mount settings.");
    expect(stepStatus(run)).toMatchObject({ music: 'failed', start: 'pending', verify: 'pending' });
    expect(fake.reports).toEqual([{ status: 'needs_you', cause: 'not_in_fstab' }]);
  });

  it('a remount that is off, busy, fails or has no healer', async () => {
    const unmounted = () => {
      fake.mount = { kind: 'absent', fstype: 'ext4', server: null, export: null, hard: false, mountPoint: '/' };
      fake.appUnmounted = true;
    };
    const notConnected = "Your music folder isn't connected, and tagave can't connect it for you. Connect the drive or share, then press Repair.";

    unmounted();
    fake.remountResult = 'off';
    let run = await repair().execute();
    expect([run.status, run.outcome?.cause, run.headline]).toEqual(['needs_you', 'music_unmounted', notConnected]);

    fake = new Fake();
    unmounted();
    run = await repair({ healer: null }).execute();
    expect([run.status, run.outcome?.cause, run.headline]).toEqual(['needs_you', 'music_unmounted', notConnected]);

    fake = new Fake();
    unmounted();
    fake.remountResult = 'busy';
    run = await repair().execute();
    expect([run.status, run.headline, run.reason]).toEqual(['failed', 'Another change is under way. Press Repair again when it ends.', 'Another change is under way. Press Repair again when it ends.']);

    fake = new Fake();
    unmounted();
    fake.remountResult = 'mount_failed';
    run = await repair().execute();
    expect(run.status).toBe('failed');
    expect(run.log.some((l) => l.message.includes('mount_failed'))).toBe(true);
  });

  it('music_unreachable: waiting, 4 of 5 parts running, then the share answers and it ends: Music share is back. All 5 parts running.', async () => {
    fake.box('worker-files').status = 'removing';
    fake.share = 'silent';
    const r = repair();
    let run = await r.execute();
    expect(run.status).toBe('waiting');
    expect(run.finishedAt).toBeNull();
    expect(run.headline).toBe("Your music share at 192.0.2.10 doesn't answer. Turn the NAS on or check its cable. tagave finishes on its own when it's back.");
    expect(run.outcome).toEqual({ cause: 'music_unreachable', service: 'worker-files', server: '192.0.2.10', partsRunning: 4, partsTotal: 5 });
    expect(run.details).toEqual(['4 of 5 parts running.', 'The file worker waits for the share.']);
    expect(run.checkedAt).toBe(new Date(fake.clock).toISOString());
    // a part stuck on a silent share is never stopped or killed
    expect(fake.changes()).toEqual([]);
    expect(fake.reports).toEqual([{ status: 'waiting', cause: 'music_unreachable' }]);

    const start = fake.clock;
    let probes = 0;
    const read = fake.music.read;
    fake.music.read = async (input) => {
      probes++;
      if (probes === 3) fake.share = 'answers';
      return read(input);
    };
    run = await r.watch();
    expect(fake.sleeps.slice(0, 3)).toEqual([60_000, 120_000, 240_000]);
    expect(fake.clock - start).toBeGreaterThanOrEqual(420_000);
    expect(run.status).toBe('repaired');
    expect(run.headline).toBe('Music share is back. All 5 parts running.');
    expect(run.outcome?.partsRunning).toBe(5);
    expect(fake.box('worker-files').status).toBe('running');
    expect(fake.reports).toEqual([{ status: 'waiting', cause: 'music_unreachable' }, { status: 'repaired', cause: 'music_unreachable' }]);
  });

  it('the watcher backs off to 5 minutes, pauses while busy, and stops when cancelled', async () => {
    fake.box('worker-files').status = 'removing';
    fake.share = 'silent';
    let busy = false;
    const r = repair({ busy: () => busy });
    await r.execute();
    const reads = fake.reads;
    fake.onSleep = (n) => { if (n === 5) busy = true; if (n === 8) r.cancel(); };
    const run = await r.watch();
    expect(run.status).toBe('waiting');
    expect(fake.sleeps).toEqual([60_000, 120_000, 240_000, 300_000, 300_000, 300_000, 300_000, 300_000]);
    // five probes back off to 5 min; from the fifth sleep on it is busy and reads nothing
    expect(fake.reads - reads).toBe(4);
  });

  it('waiting survives an updater restart from repair.json', async () => {
    fake.box('worker-files').status = 'removing';
    fake.share = 'silent';
    const file = join(dir, REPAIR_STATE_FILE);
    const save = async (run: RepairRun) => {
      const { mkdir } = await import('node:fs/promises');
      await mkdir(join(dir, '.updater'), { recursive: true });
      await writeFile(file, JSON.stringify(run));
    };
    const first = await repair({ save }).execute();
    expect(first.status).toBe('waiting');

    // a new updater process: a new Repair from what repair.json says
    const loaded = JSON.parse(await readFile(file, 'utf8')) as RepairRun;
    expect(loaded.status).toBe('waiting');
    fake.share = 'answers';
    const run = await new Repair(deps({ save }), loaded).watch();
    expect(run.status).toBe('repaired');
    expect(run.headline).toBe('Music share is back. All 5 parts running.');
    expect((JSON.parse(await readFile(file, 'utf8')) as RepairRun).status).toBe('repaired');
  });

  it('stuck_stop with the share fine: needs_you, "The file worker is stuck and won\'t stop. Restart the computer tagave runs on."', async () => {
    Object.assign(fake.box('worker-files'), { status: 'removing', stopHangs: true });
    const run = await repair().execute();
    expect(run.status).toBe('needs_you');
    expect(run.outcome?.cause).toBe('stuck_stop');
    expect(run.outcome?.service).toBe('worker-files');
    expect(run.headline).toBe("The file worker is stuck and won't stop. Restart the computer tagave runs on.");
    expect(run.details).toContain('tagave tried to stop it twice. Your music and library are safe.');
    expect(fake.calls.filter((c) => c[0] === 'kill')).toHaveLength(1);
    expect(fake.calls.filter((c) => c[1] === 'stop')).toHaveLength(1);
  });

  it('crash loop: one recreate, then needs_you with the last error line', async () => {
    Object.assign(fake.box('worker-files'), {
      status: 'restarting',
      exitCode: 1,
      restarts: 7,
      logs: 'starting\nError: cannot open /data/library.db\n',
      up: (b: Box) => { b.status = 'restarting'; },
    });
    const run = await repair().execute();
    expect(run.status).toBe('needs_you');
    expect(run.outcome?.cause).toBe('crash_loop');
    expect(run.headline).toBe('The file worker keeps stopping. tagave restarted it once.');
    expect(run.details).toContain('Last error: Error: cannot open /data/library.db');
    expect(run.details).toContain('Started the file worker again from scratch.');
    expect(fake.calls.filter((c) => c.includes('--force-recreate'))).toEqual([['compose', 'up', '-d', '--no-deps', '--force-recreate', 'worker-files']]);
  });

  it('oom: one recreate', async () => {
    Object.assign(fake.box('worker-identify'), { status: 'exited', exitCode: 137, oom: true });
    const run = await repair().execute();
    expect(run.status).toBe('repaired');
    expect(run.outcome?.cause).toBe('oom');
    expect(run.headline).toBe('Repaired. All 5 parts running.');
    expect(fake.changes()).toEqual([['compose', 'up', '-d', '--no-deps', '--force-recreate', 'worker-identify']]);
  });

  it('oom again after its one recreate: needs_you', async () => {
    Object.assign(fake.box('worker-files'), { status: 'exited', exitCode: 137, oom: true, up: (b: Box) => { b.status = 'exited'; } });
    const run = await repair().execute();
    expect(run.status).toBe('needs_you');
    expect(run.headline).toBe('The file worker ran out of memory. Close other programs on this computer, then press Repair.');
    expect(fake.calls.filter((c) => c.includes('--force-recreate'))).toHaveLength(1);
    // the recreate did not start it, so no line says it did
    expect(run.details.some((d) => d.includes('again from scratch'))).toBe(false);
  });

  it('disk_full under 256 MB: no action, "The disk is full (180 MB free)…"', async () => {
    fake.freeBytes = 180 * MB;
    fake.box('worker-files').status = 'exited';
    const run = await repair().execute();
    expect(run.status).toBe('needs_you');
    expect(run.outcome?.cause).toBe('disk_full');
    expect(run.headline).toBe('The disk is full (180 MB free). Free up space, then press Repair.');
    expect(run.details).toContain('tagave never deletes files for you.');
    expect(fake.changes()).toEqual([]);
  });

  it('port_conflict: "Another program uses port 4533…"', async () => {
    Object.assign(fake.box('player'), { status: 'exited', exitCode: 128, error: 'driver failed programming external connectivity on endpoint tagave-player-1: Bind for 0.0.0.0:4533 failed: port is already allocated' });
    const run = await repair().execute();
    expect(run.status).toBe('needs_you');
    expect(run.outcome).toMatchObject({ cause: 'port_conflict', service: 'player' });
    expect(run.headline).toBe('Another program uses port 4533. Stop that program, then press Repair.');
    expect(fake.changes()).toEqual([]);
  });

  it('app unhealthy: one restart, never while the app backs up or migrates', async () => {
    let ok = false;
    fake.healthy = () => ok;
    fake.onAppRestart = () => { ok = true; };
    let run = await repair().execute();
    expect(fake.appRestarts).toBe(1);
    expect(fake.calls.filter((c) => c[1] === 'restart')).toEqual([['compose', 'restart', 'app']]);
    expect(run.status).toBe('repaired');
    expect(run.outcome?.cause).toBe('app_unhealthy');
    expect(run.details).toContain('Restarted the web app.');

    // still failing after its one restart
    fake = new Fake();
    fake.healthy = () => false;
    fake.box('app').logs = 'listening\nError: connect ECONNREFUSED 192.0.2.20:5432\n';
    run = await repair().execute();
    expect(fake.appRestarts).toBe(1);
    expect(run.status).toBe('needs_you');
    expect(run.headline).toBe("The web app doesn't answer. tagave restarted it once.");
    expect(run.details).toContain('Last error: Error: connect ECONNREFUSED 192.0.2.20:5432');

    // backing up before a migration: wait, never restart
    fake = new Fake();
    const until = fake.clock + 90_000;
    fake.healthy = () => fake.clock >= until;
    fake.box('app').logs = 'backing up the database to /backups/pre.dump before applying 3 migrations\n';
    run = await repair().execute();
    expect(fake.appRestarts).toBe(0);
    expect(run.status).toBe('repaired');
    expect(fake.changes()).toEqual([]);
  });

  it('migration refused: needs_you with the reason', async () => {
    fake.healthy = () => false;
    fake.box('app').logs = 'Not migrating: the database is newer than this app.\n';
    const run = await repair().execute();
    expect(run.status).toBe('needs_you');
    expect(run.outcome?.cause).toBe('migration_refused');
    expect(run.headline).toBe('The web app refuses to update the database: the database is newer than this app.');
    expect(fake.appRestarts).toBe(0);
  });

  it('db_recovering: waits, never restarts postgres', async () => {
    const until = fake.clock + 2 * 60_000;
    fake.box('postgres').logs = () => `database system was interrupted\nredo starts at 0/1\n${fake.clock >= until ? 'database system is ready to accept connections\n' : ''}`;
    fake.healthy = () => fake.clock >= until;
    let run = await repair().execute();
    expect(run.status).toBe('repaired');
    expect(fake.changes()).toEqual([]);

    // still recovering when the time is up
    fake = new Fake();
    fake.box('postgres').logs = 'database system was interrupted\nautomatic recovery in progress\n';
    fake.healthy = () => false;
    run = await repair().execute();
    expect(run.status).toBe('needs_you');
    expect(run.outcome?.cause).toBe('db_recovering');
    expect(run.headline).toBe('The database is recovering after an unclean stop. Wait, this can take a few minutes.');
    expect(run.details).toContain("Don't restart the computer while it recovers.");
    expect(fake.changes()).toEqual([]);
  });

  it('docker not answering: needs_you with docker_unresponsive', async () => {
    fake.dockerAnswers = false;
    const run = await repair().execute();
    expect(run.status).toBe('needs_you');
    expect(run.outcome?.cause).toBe('docker_unresponsive');
    expect(run.headline).toBe("Docker isn't answering. Restart Docker or the computer, then run the installer again.");
    expect(fake.calls).toEqual([['version', '--format', '{{.Server.Version}}']]);
    expect(stepStatus(run)).toMatchObject({ check: 'failed' });
  });

  it('a report that throws does not stop the run', async () => {
    const run = await repair({ report: async () => { throw new Error('the app went away'); } }).execute();
    expect(run.status).toBe('repaired');
    expect(run.log.some((l) => l.level === 'warn' && l.message.includes('could not tell the app'))).toBe(true);
  });

  it('an app that never runs: no restart is claimed, it ends "won\'t start"', async () => {
    Object.assign(fake.box('app'), { health: 'starting' });
    fake.healthy = () => false;
    const run = await repair().execute();
    expect(fake.appRestarts).toBe(0);
    expect(run.status).toBe('needs_you');
    expect(run.outcome).toMatchObject({ cause: 'stuck_stop', service: 'app' });
    expect(run.headline).toBe("The web app won't start. Restart the computer tagave runs on.");
    expect(run.details).not.toContain('Restarted the web app.');
  });

  it('an app restart that fails is not recorded as done, and the ending claims none', async () => {
    fake.healthy = () => false;
    fake.restartCode = 1;
    const run = await repair().execute();
    expect(fake.appRestarts).toBe(1);
    expect(run.details).not.toContain('Restarted the web app.');
    expect(run.headline).toBe("The web app won't start. Restart the computer tagave runs on.");
  });

  it('the one app restart waits until every other part runs', async () => {
    const until = fake.clock + 30_000;
    Object.assign(fake.box('postgres'), { health: 'starting' });
    fake.onSleep = () => { if (fake.clock >= until) fake.box('postgres').health = 'healthy'; };
    let ok = false;
    let restartAt = 0;
    fake.healthy = () => ok;
    fake.onAppRestart = () => { ok = true; restartAt = fake.clock; };
    const run = await repair().execute();
    expect(fake.appRestarts).toBe(1);
    expect(restartAt).toBeGreaterThanOrEqual(until);
    expect(run.status).toBe('repaired');
  });

  it('free text from the app and the logs is redacted and capped', async () => {
    const long = 'x'.repeat(1000);
    fake.healthy = () => false;
    fake.box('app').logs = `Not migrating: cannot reach postgres://robin:secret@192.0.2.10/db ${long}\n`;
    let run = await repair().execute();
    expect(run.outcome?.cause).toBe('migration_refused');
    for (const text of [run.headline!, run.reason!, ...run.details]) expect(text).not.toContain('secret');
    expect(run.headline).toContain('postgres://robin:***@192.0.2.10/db');
    expect(run.headline!.length).toBeLessThanOrEqual('The web app refuses to update the database: .'.length + 300);
    expect(JSON.stringify(fake.saved.at(-1))).not.toContain('secret');

    fake = new Fake();
    Object.assign(fake.box('worker-files'), {
      status: 'restarting',
      exitCode: 1,
      logs: `Error: lost postgres://robin:secret@192.0.2.10/db ${long}\n`,
      up: (b: Box) => { b.status = 'restarting'; },
    });
    run = await repair().execute();
    expect(run.outcome?.cause).toBe('crash_loop');
    const line = run.details.find((d) => d.startsWith('Last error: '))!;
    expect(line).toContain('robin:***@');
    expect(line).not.toContain('secret');
    expect(line.length).toBeLessThanOrEqual('Last error: '.length + 300);
  });

  it('port_conflict takes the port from the line that names the conflict', async () => {
    Object.assign(fake.box('player'), { status: 'exited', exitCode: 1, logs: '2026-11-25 10:00:12 starting the player\n2026-11-25T10:00:13Z listen tcp 0.0.0.0:4533: bind: address already in use\n' });
    const run = await repair().execute();
    expect(run.headline).toBe('Another program uses port 4533. Stop that program, then press Repair.');
  });

  it('a share that is silent with no part down ends needs_you, not "Music share is back"', async () => {
    fake.mount = { kind: 'absent', fstype: 'ext4', server: null, export: null, hard: false, mountPoint: '/' };
    fake.appUnmounted = true;
    fake.remountResult = 'server_silent';
    const run = await repair().execute();
    expect(run.status).toBe('needs_you');
    expect(run.outcome?.cause).toBe('music_unreachable');
    expect(run.headline).toBe("Your music share doesn't answer. Turn the NAS on or check its cable, then press Repair.");
  });

  it('the watcher with no music prober says once that it cannot check the share', async () => {
    fake.box('worker-files').status = 'removing';
    fake.share = 'silent';
    const first = await repair().execute();
    expect(first.status).toBe('waiting');
    const r = new Repair(deps({ music: null }), structuredClone(first));
    fake.onSleep = (n) => { if (n === 3) r.cancel(); };
    const run = await r.watch();
    expect(run.status).toBe('waiting');
    expect(run.log.filter((l) => l.message.includes('cannot be checked'))).toHaveLength(1);
  });

  it('the watcher sends a share that is no longer mounted to the remount, not to "answers"', async () => {
    fake.box('worker-files').status = 'removing';
    fake.share = 'silent';
    const r = repair();
    expect((await r.execute()).status).toBe('waiting');
    fake.mount = { kind: 'absent', fstype: 'ext4', server: null, export: null, hard: false, mountPoint: '/' };
    fake.appUnmounted = true;
    const run = await r.watch();
    expect(fake.remounts).toEqual([['/mnt/music', 'tagave']]);
    expect(run.status).toBe('repaired');
    expect(run.headline).toBe('Music share was not connected. Connected it again. All 5 parts running.');
  });
});

describe('repairHeadline', () => {
  const o = (cause: RepairCause | null, service: string | null = null, server: string | null = null) => ({ cause, service, server, partsRunning: 4, partsTotal: 5 });
  it('names parts by their label and falls back when a value is unknown', () => {
    expect(repairHeadline({ status: 'needs_you', outcome: o('stuck_stop', 'player') })).toBe("The player is stuck and won't stop. Restart the computer tagave runs on.");
    expect(repairHeadline({ status: 'waiting', outcome: o('music_unreachable', 'worker-files', null) })).toBe("Your music share doesn't answer. Turn the NAS on or check its cable. tagave finishes on its own when it's back.");
    expect(repairHeadline({ status: 'needs_you', outcome: o('disk_full') })).toBe('The disk is full. Free up space, then press Repair.');
    expect(repairHeadline({ status: 'needs_you', outcome: o('port_conflict', 'app') }, { port: 4533 })).toBe('Another program uses port 4533. Stop that program, then press Repair.');
  });
});
