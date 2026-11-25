import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PartState, RepairRun, UpdateRun } from '@tagave/shared/updater';
import { assertAllowed } from './argv-guard.testkit.js';
import { musicVerdict, type MusicProber, type ServerAnswer } from './music-probe.js';
import { INSPECT_FORMAT } from './progress.js';
import { REPAIR_STATE_FILE, newRepairRun } from './repair.js';
import type { CommandResult, Runner } from './runner.js';
import { SignatureVerifier, signRequest, SIGNATURE_HEADER, TIME_HEADER } from './token.js';
import { UpdaterService, STATE_DIR, type UpdaterOptions } from './server.js';
import { DEFAULT_CONFIG, newRun } from './update.js';
import { signed, testKey, testManifest } from './release.testkit.js';

const KEY = testKey();
const release = (version: string) => {
  const { text, signature } = signed(KEY, testManifest(version));
  return JSON.stringify({ version, manifest: text, signature });
};

const SECRET = 'a'.repeat(44);
const SERVICES = ['postgres', 'app', 'worker-files'];
const cid = (svc: string) => Buffer.from(svc).toString('hex').padEnd(12, '0');
const serviceOf = (id: string) => SERVICES.find((s) => cid(s) === id)!;

/**
 * A small install: each part's container status, a share that answers or
 * not, and calls that can be made to hang. Every argv passes the allowlist.
 */
class Fake {
  calls: string[][] = [];
  status = new Map<string, string>(SERVICES.map((s) => [s, 'running']));
  share: ServerAnswer = 'answers';
  /** `compose ps` for these never answers. */
  hangPs = new Set<string>();
  /** `docker version` waits for this when set. */
  versionGate: Promise<void> | null = null;
  reports: Array<{ status: string; cause: string | null }> = [];

  docker: Runner = async (args) => {
    assertAllowed(args);
    this.calls.push(args);
    return { code: 0, stdout: '', stderr: '', ...(await this.answer(args)) };
  };

  private async answer(a: string[]): Promise<Partial<CommandResult>> {
    const j = a.join(' ');
    if (a[0] === 'version') {
      await this.versionGate;
      return { stdout: '28.0.0\n' };
    }
    if (j === 'compose config --services') return { stdout: `${SERVICES.join('\n')}\nupdater\n` };
    if (a[0] === 'compose' && a[1] === 'ps') {
      const svc = a.at(-1)!;
      if (this.hangPs.has(svc)) return new Promise(() => {});
      return { stdout: `${cid(svc)}\n` };
    }
    if (a[0] === 'inspect') {
      const st = this.status.get(serviceOf(a.at(-1)!))!;
      if (a[2] === INSPECT_FORMAT) return { stdout: `${JSON.stringify({ Status: st, Restarting: false, OOMKilled: false, ExitCode: 0, Error: '', Health: null })}|0\n` };
      return { stdout: a[2] === '{{.State.Status}}' ? `${st}\n` : `${st}|\n` };
    }
    if (a[0] === 'logs') return {};
    if (a[0] === 'compose' && a[1] === 'up') {
      this.status.set(a.at(-1)!, 'running');
      return {};
    }
    if (a[0] === 'compose' && a[1] === 'stop') {
      this.status.set(a.at(-1)!, 'exited');
      return {};
    }
    if (j === 'ps -q --filter label=tagave.updater.handover') return {};
    return { code: 1, stderr: 'no' };
  }

  music: MusicProber = {
    read: async ({ parts, appUnmounted }) => {
      const mount = { kind: 'network' as const, fstype: 'nfs4', server: '192.0.2.10', export: '/music', hard: true, mountPoint: '/mnt/music' };
      return { dir: '/mnt/music', mount, answer: this.share, verdict: musicVerdict(mount, this.share, parts, appUnmounted), server: '192.0.2.10' };
    },
  };

  versions(): number {
    return this.calls.filter((c) => c[0] === 'version').length;
  }
}

describe('request signatures', () => {
  const req = (h: Record<string, string>, body = '') => ({ method: 'POST', path: '/v1/update', body, time: h[TIME_HEADER], signature: h[SIGNATURE_HEADER] });

  it('accepts a signed request once', () => {
    const v = new SignatureVerifier(SECRET);
    const h = signRequest(SECRET, 'POST', '/v1/update', '{"version":"0.8.0"}');
    expect(v.verify(req(h, '{"version":"0.8.0"}'))).toEqual({ ok: true });
    expect(v.verify(req(h, '{"version":"0.8.0"}'))).toEqual({ ok: false, reason: 'replayed signature' });
  });

  it('refuses another secret, a changed body or path, an old signature and no signature', () => {
    const v = new SignatureVerifier(SECRET);
    expect(v.verify(req(signRequest('b'.repeat(44), 'POST', '/v1/update', '{}'), '{}')).ok).toBe(false);
    expect(v.verify(req(signRequest(SECRET, 'POST', '/v1/update', '{"version":"0.8.0"}'), '{"version":"9.9.9"}')).ok).toBe(false);
    const h = signRequest(SECRET, 'POST', '/v1/other', '');
    expect(v.verify({ ...req(h), path: '/v1/update' }).ok).toBe(false);
    const old = signRequest(SECRET, 'POST', '/v1/update', '', Date.now() - 120_000);
    expect(v.verify(req(old))).toEqual({ ok: false, reason: 'signature expired' });
    expect(v.verify({ method: 'GET', path: '/', body: '', time: undefined, signature: undefined })).toEqual({ ok: false, reason: 'unsigned request' });
    expect(v.verify({ method: 'GET', path: '/', body: '', time: '1.zz', signature: 'x' })).toEqual({ ok: false, reason: 'malformed signature' });
  });
});

describe('updater HTTP API', () => {
  let dir: string;
  let server: Server;
  let base: string;
  let service: UpdaterService;
  let fake: Fake;
  let services: UpdaterService[];

  const make = (over: Partial<UpdaterOptions> = {}) => {
    const s = new UpdaterService({
      installDir: dir,
      appSecret: SECRET,
      keys: [KEY.trusted],
      version: '0.7.0',
      // parts that run, but nothing else Docker is asked does: an update fails at preflight
      docker: fake.docker,
      app: { health: async () => ({ ok: true, detail: 'ok' }), versions: async () => ({ app: '0.7.0', workers: [] }) },
      config: { ...DEFAULT_CONFIG, selfUpdate: false, pollMs: 5 },
      music: fake.music,
      musicUnmounted: async () => false,
      report: async (end) => { fake.reports.push(end); },
      repairConfig: { healthTimeoutMs: 2000, pollMs: 5, waitFirstMs: 3_600_000 },
      ...over,
    });
    services.push(s);
    return s;
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tagave-updater-srv-'));
    await writeFile(join(dir, '.env'), 'TAGAVE_ROLE=all\nTAGAVE_VERSION=0.7.0\nCOMPOSE_PROJECT_NAME=tagave\nMUSIC_DIR=/mnt/music\n');
    fake = new Fake();
    services = [];
    service = make();
    server = service.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    for (const s of services) {
      await s.idle();
      s.stop();
      // a watcher's last saves land before the folder goes
      await s['repairWatch'];
      await s.repairSaved();
    }
    await new Promise((r) => server.close(r));
    await rm(dir, { recursive: true, force: true });
  });

  const call = (method: string, path: string, body = '', secret = SECRET) =>
    fetch(`${base}${path}`, { method, headers: signRequest(secret, method, path, body), ...(body ? { body } : {}) });

  it('refuses unsigned and wrongly signed calls', async () => {
    expect((await fetch(`${base}/v1/status`)).status).toBe(401);
    expect((await call('GET', '/v1/status', '', 'c'.repeat(44))).status).toBe(401);
  });

  it('reports its status, the configured version and the services an update restarts', async () => {
    const res = await call('GET', '/v1/status');
    expect(res.status).toBe(200);
    const running = (service: string): PartState => ({ service, state: 'running', health: null });
    expect(await res.json()).toEqual({
      version: '0.7.0', configuredVersion: '0.7.0', role: 'all', services: SERVICES, run: null, selfReplace: null,
      parts: SERVICES.map(running), repair: null,
    });
  });

  it('starts a run, keeps its state on disk, and refuses a bad version', async () => {
    expect((await call('POST', '/v1/update', '{"version":"latest"}')).status).toBe(400);
    const unsigned = await call('POST', '/v1/update', '{"version":"0.8.0"}');
    expect(unsigned.status).toBe(422);
    expect(await unsigned.json()).toMatchObject({ check: 'unsigned' });
    const res = await call('POST', '/v1/update', release('0.8.0'));
    expect(res.status).toBe(202);
    await service.idle();
    const state = JSON.parse(await readFile(join(dir, STATE_DIR, 'state.json'), 'utf8')) as UpdateRun;
    expect(state.status).toBe('failed');
    expect(state.target).toBe('0.8.0');
    const status = (await (await call('GET', '/v1/status')).json()) as { run: UpdateRun };
    expect(status.run.id).toBe(state.id);
  });

  it('marks a run that was cut off as interrupted when it starts again', async () => {
    const run = newRun('r1', '0.7.0', '0.8.0', new Date());
    run.steps[4]!.status = 'running';
    run.backup = '/backups/x.pgdump';
    await mkdir(join(dir, STATE_DIR), { recursive: true });
    await writeFile(join(dir, STATE_DIR, 'state.json'), JSON.stringify(run));
    await service.load();
    const status = (await (await call('GET', '/v1/status')).json()) as { run: UpdateRun };
    expect(status.run.status).toBe('interrupted');
    expect(status.run.reason).toMatch(/Restart the app, then the workers.*\/backups\/x\.pgdump/);
  });

  it('points an interrupted run without a backup yet at the first one taken after it started', async () => {
    const run = newRun('r2', '0.7.0', '0.8.0', new Date('2026-10-16T10:00:00Z'));
    run.steps[4]!.status = 'running';
    run.progress = { step: 'restart', message: 'waiting for the app: database recovering', at: run.startedAt };
    await mkdir(join(dir, STATE_DIR), { recursive: true });
    await writeFile(join(dir, STATE_DIR, 'state.json'), JSON.stringify(run));
    await service.load();
    const status = (await (await call('GET', '/v1/status')).json()) as { run: UpdateRun };
    expect(status.run.reason).toContain('the first one under Before update in Settings › Backups taken after 2026-10-16T10:00:00.000Z');
    expect(status.run.progress).toBeNull();
  });

  describe('repair', () => {
    const writeRun = async (file: string, value: unknown) => {
      await mkdir(join(dir, STATE_DIR), { recursive: true });
      await writeFile(join(dir, file), JSON.stringify(value));
    };
    const statusOf = async () => (await (await call('GET', '/v1/status')).json()) as { repair: RepairRun | null; parts: PartState[] };
    /** The file worker stuck on a silent share: the repair ends waiting. */
    const toWaiting = async () => {
      fake.status.set('worker-files', 'removing');
      fake.share = 'silent';
      const res = await call('POST', '/v1/repair');
      expect(res.status).toBe(202);
      await service.idle();
      const { repair } = await statusOf();
      expect(repair?.status).toBe('waiting');
      return repair!;
    };

    it('signed /v1/repair starts one, unsigned is 401', async () => {
      expect((await fetch(`${base}/v1/repair`, { method: 'POST' })).status).toBe(401);
      expect(fake.versions()).toBe(0);
      // the app's call: an empty body signed over '', no content-type
      const res = await call('POST', '/v1/repair');
      expect(res.status).toBe(202);
      const { run } = (await res.json()) as { run: RepairRun };
      expect(run).toMatchObject({ kind: 'repair', trigger: 'owner', status: 'running' });
      await service.idle();
      const { repair } = await statusOf();
      expect(repair).toMatchObject({ id: run.id, status: 'repaired', headline: 'All 3 parts running. Nothing to repair.' });
      expect(JSON.parse(await readFile(join(dir, REPAIR_STATE_FILE), 'utf8'))).toMatchObject({ id: run.id, status: 'repaired' });
      expect(fake.reports).toEqual([{ status: 'repaired', cause: null }]);
    });

    it('409 while an update, a module run, a repair or a self-replace runs', async () => {
      // a repair: the first one waits on Docker
      let open!: () => void;
      fake.versionGate = new Promise((r) => { open = r; });
      expect((await call('POST', '/v1/repair')).status).toBe(202);
      expect(service.moving()).toBe(true);
      expect(service.updating()).toBe(false);
      const again = await call('POST', '/v1/repair');
      expect(again.status).toBe(409);
      expect(await again.json()).toEqual({ error: 'a repair is running' });
      // ...and an update or a module run waits for it too
      expect((await call('POST', '/v1/update', release('0.8.0'))).status).toBe(409);
      open();
      await service.idle();
      fake.versionGate = null;

      // an update
      service['active'] = new Promise(() => {});
      expect((await call('POST', '/v1/repair')).status).toBe(409);
      service['active'] = null;

      // a module run (the installer's one-off writes the same file)
      await writeRun(join(STATE_DIR, 'module-run.json'), { status: 'running', startedAt: new Date().toISOString(), moduleName: 'Player', action: 'enable' });
      expect(await (await call('POST', '/v1/repair')).json()).toEqual({ error: 'Player is being turned on' });
      await rm(join(dir, STATE_DIR, 'module-run.json'));
      service['moduleRun'] = null;

      // a repair the installer's one-off runs, under 1 h old
      await writeRun(REPAIR_STATE_FILE, newRepairRun('installer-1', 'installer', new Date()));
      expect((await call('POST', '/v1/repair')).status).toBe(409);
      await writeRun(REPAIR_STATE_FILE, newRepairRun('installer-2', 'installer', new Date(Date.now() - 2 * 3600_000)));
      expect((await call('POST', '/v1/repair')).status).toBe(202);
      await service.idle();

      // a self-replace
      await service['selfReplace'].begin('0.8.0', 'r1');
      const res = await call('POST', '/v1/repair');
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ selfReplace: { expectedVersion: '0.8.0' } });
    });

    it('one run at a time: two Repair presses, or an update and a repair, started together', async () => {
      const both = await Promise.all([call('POST', '/v1/repair'), call('POST', '/v1/repair')]);
      expect(both.map((r) => r.status).sort()).toEqual([202, 409]);
      await service.idle();
      const mixed = await Promise.all([call('POST', '/v1/update', release('0.8.0')), call('POST', '/v1/repair')]);
      expect(mixed.map((r) => r.status).sort()).toEqual([202, 409]);
      await service.idle();
      // the update and the held hand-over inside this process claim the same slot
      const [a, b] = await Promise.all([service.startRepair('update'), service.startRepair('owner')]);
      expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    });

    it('a repair that cannot be saved does not linger', async () => {
      const logs: string[] = [];
      const s = make({ log: (_level, m) => { logs.push(m); } });
      // the write fails (a seam, not file modes: root ignores those)
      const write = s['writeRepair'].bind(s);
      s['writeRepair'] = async () => { throw new Error('ENOSPC: no space left on device'); };
      const res = await s.startRepair('owner');
      expect(res).toMatchObject({ ok: false, status: 500, error: 'the repair could not be saved: ENOSPC: no space left on device' });
      expect(s.moving()).toBe(false);
      expect(fake.versions()).toBe(0);
      // the held hand-over does not throw either
      const held: UpdateRun = { ...newRun('u1', '0.7.0', '0.8.0', new Date()), status: 'held', held: { cause: 'music_unreachable', parts: ['worker-files'], server: '192.0.2.10' } };
      await expect(s['afterUpdate'](held)).resolves.toBeUndefined();
      expect(logs[0]).toMatch(/^the held update could not hand its parts to a repair: the repair could not be saved/);
      s['writeRepair'] = write;
      expect((await s.startRepair('owner')).ok).toBe(true);
    });

    it('a status call during the first save never replaces the new repair, and its later saves land', async () => {
      await writeRun(REPAIR_STATE_FILE, { ...newRepairRun('old', 'owner', new Date()), status: 'repaired' });
      expect((await statusOf()).repair?.id).toBe('old');
      let open!: () => void;
      const gate = new Promise<void>((r) => { open = r; });
      const write = service['writeRepair'].bind(service);
      let first = true;
      service['writeRepair'] = async (run: RepairRun) => {
        if (first) { first = false; await gate; }
        return write(run);
      };
      const started = service.startRepair('owner');
      // the old file is read while the new run's first write waits
      const during = await statusOf();
      expect(during.repair?.id).not.toBe('old');
      open();
      const res = await started;
      expect(res.ok).toBe(true);
      const id = res.ok ? res.run.id : '';
      await service.idle();
      expect((await statusOf()).repair).toMatchObject({ id, status: 'repaired' });
      expect(JSON.parse(await readFile(join(dir, REPAIR_STATE_FILE), 'utf8'))).toMatchObject({ id, status: 'repaired' });
    });

    it('an installer repair marked running for over an hour has stopped', async () => {
      await writeRun(REPAIR_STATE_FILE, newRepairRun('installer-old', 'installer', new Date(Date.now() - 2 * 3600_000)));
      const { repair } = await statusOf();
      expect(repair).toMatchObject({ id: 'installer-old', status: 'failed', reason: 'The repair stopped. Press Repair again.' });
      expect(JSON.parse(await readFile(join(dir, REPAIR_STATE_FILE), 'utf8'))).toMatchObject({ status: 'failed' });
      expect(fake.reports).toEqual([{ status: 'failed', cause: null }]);
      // two reads at once fail it once
      await writeRun(REPAIR_STATE_FILE, newRepairRun('installer-old2', 'installer', new Date(Date.now() - 2 * 3600_000)));
      await Promise.all([statusOf(), statusOf()]);
      expect(fake.reports).toEqual([{ status: 'failed', cause: null }, { status: 'failed', cause: null }]);
      // under an hour it still runs
      await writeRun(REPAIR_STATE_FILE, newRepairRun('installer-new', 'installer', new Date()));
      expect((await statusOf()).repair).toMatchObject({ id: 'installer-new', status: 'running' });
    });

    it("a status call never takes back this process's finished repair from an older file", async () => {
      const res = await service.startRepair('owner');
      expect(res.ok).toBe(true);
      await service.idle();
      const own = (await statusOf()).repair!;
      expect(own.status).toBe('repaired');
      // the file still holds the run's earlier "running" save (a status read in the gap of the last write)
      await writeRun(REPAIR_STATE_FILE, { ...own, status: 'running', finishedAt: null, startedAt: new Date(Date.now() - 2 * 3600_000).toISOString() });
      expect((await statusOf()).repair).toMatchObject({ id: own.id, status: 'repaired' });
      expect(fake.reports).toEqual([{ status: 'repaired', cause: null }]);
    });

    it('only an installer repair is failed as stale', async () => {
      await writeRun(REPAIR_STATE_FILE, newRepairRun('owner-old', 'owner', new Date(Date.now() - 2 * 3600_000)));
      expect((await statusOf()).repair).toMatchObject({ id: 'owner-old', status: 'running' });
      expect(fake.reports).toEqual([]);
    });

    it('a reading begun before the parts changed is not kept', async () => {
      const s = make({ partsDeadlineMs: 20 });
      let open!: () => void;
      const gate = new Promise<void>((r) => { open = r; });
      const docker = fake.docker;
      const gated: typeof docker = async (args, opts) => { if (args[1] === 'ps') await gate; return docker(args, opts); };
      s['opts'].docker = gated;
      expect((await s.status()).parts?.every((p) => p.state === 'stuck')).toBe(true);
      const inFlight = s['partsRefresh']!.done;
      s['partsChanged']();
      open();
      await inFlight;
      expect(s['partsCache']).toBeNull();
    });

    it('a waiting repair does not block an update', async () => {
      await toWaiting();
      expect(service.moving()).toBe(false);
      expect((await call('POST', '/v1/update', release('0.8.0'))).status).toBe(202);
    });

    it('Repair while waiting restarts at check', async () => {
      const first = await toWaiting();
      expect(fake.versions()).toBe(1);
      fake.share = 'answers';
      fake.status.set('worker-files', 'exited');
      const res = await call('POST', '/v1/repair');
      expect(res.status).toBe(202);
      const { run } = (await res.json()) as { run: RepairRun };
      expect(run.id).not.toBe(first.id);
      await service.idle();
      expect(fake.versions()).toBe(2);
      const { repair } = await statusOf();
      expect(repair).toMatchObject({ id: run.id, status: 'repaired' });
      expect(fake.status.get('worker-files')).toBe('running');
      // the old run's watcher writes nothing more
      expect(JSON.parse(await readFile(join(dir, REPAIR_STATE_FILE), 'utf8'))).toMatchObject({ id: run.id });
    });

    describe("another process's repair (the installer's one-off)", () => {
      const quick = { healthTimeoutMs: 2000, pollMs: 5, waitFirstMs: 5, waitMaxMs: 5 };
      const until = async (done: () => boolean | Promise<boolean>) => {
        for (let i = 0; i < 400 && !(await done()); i++) await new Promise((r) => setTimeout(r, 5));
        expect(await done()).toBe(true);
      };
      const onDisk = async () => JSON.parse(await readFile(join(dir, REPAIR_STATE_FILE), 'utf8')) as RepairRun;
      /** cli.js repair: its run ends waiting on a silent share, and the one-off exits. */
      const installerWaiting = async () => {
        const cli = make({ repairConfig: { ...quick, waitFirstMs: 3_600_000 } });
        fake.status.set('worker-files', 'removing');
        fake.share = 'silent';
        const started = await cli.startRepair('installer');
        if (!started.ok) throw new Error(started.error);
        await cli.idle();
        expect(started.run.status).toBe('waiting');
        cli.stop();
        return started.run;
      };

      it('a waiting installer repair is adopted, and its watcher finishes it when the share answers', async () => {
        const run = await installerWaiting();
        const s = make({ repairConfig: quick });
        // the long-running service follows the file (its timer never fires here)
        s.followRepairFile(3_600_000);
        expect((await s.status()).repair).toMatchObject({ id: run.id, trigger: 'installer', status: 'waiting' });
        expect(s['repair']?.run.id).toBe(run.id);
        fake.share = 'answers';
        await until(async () => (await onDisk()).status === 'repaired');
        expect(await onDisk()).toMatchObject({ id: run.id, trigger: 'installer' });
        expect(fake.status.get('worker-files')).toBe('running');
        // the app's audit entry says how it ended
        await until(() => fake.reports.at(-1)?.status === 'repaired');
      });

      it('a waiting watcher here yields when repair.json names another run', async () => {
        const s = make({ repairConfig: quick });
        fake.status.set('worker-files', 'removing');
        fake.share = 'silent';
        const own = await s.startRepair('owner');
        if (!own.ok) throw new Error(own.error);
        await s.idle();
        expect(own.run.status).toBe('waiting');
        const watcher = s['repair']!;
        // the installer's one-off starts its own repair over the file
        await writeRun(REPAIR_STATE_FILE, newRepairRun('installer-1', 'installer', new Date()));
        expect((await s.status()).repair).toMatchObject({ id: 'installer-1', status: 'running' });
        expect(watcher['cancelled']).toBe(true);
        // the old watcher writes nothing more, and the one-off's run counts as running elsewhere
        await new Promise((r) => setTimeout(r, 50));
        expect((await onDisk()).id).toBe('installer-1');
        expect(await s.startRepair('owner')).toMatchObject({ ok: false, error: 'a repair is running' });
      });

      it('a process that does not follow the file (cli.js) never adopts a waiting run', async () => {
        const run = await installerWaiting();
        const s = make({ repairConfig: quick });
        expect((await s.status()).repair).toMatchObject({ id: run.id, status: 'waiting' });
        expect(s['repair']).toBeNull();
      });

      it('a waiting watcher whose file another process replaced writes nothing more and stops, with no status call', async () => {
        const s = make({ repairConfig: quick });
        fake.status.set('worker-files', 'removing');
        fake.share = 'silent';
        const own = await s.startRepair('installer');
        if (!own.ok) throw new Error(own.error);
        await s.idle();
        expect(own.run.status).toBe('waiting');
        const watcher = s['repair']!;
        // the service starts a repair (Repair pressed in Settings) while this one waits
        await writeRun(REPAIR_STATE_FILE, newRepairRun('owner-1', 'owner', new Date()));
        await until(() => watcher['cancelled'] === true);
        await s.repairSaved();
        await new Promise((r) => setTimeout(r, 50));
        expect((await onDisk()).id).toBe('owner-1');
        expect(s['repair']).toBeNull();
        expect(s['repairWatch']).toBeNull();
      });

      it('the service reads repair.json on its own timer, and stop() ends the timer', async () => {
        const s = make({ repairConfig: quick });
        s.followRepairFile(10);
        const run = await installerWaiting();
        await until(() => s['repair']?.run.id === run.id);
        fake.share = 'answers';
        await until(async () => (await onDisk()).status === 'repaired');
        s.stop();
        expect(s['repairTimer']).toBeNull();
      });
    });

    it('status answers in time with a hanging part (parts shows it stuck)', async () => {
      const slow = make({ partsDeadlineMs: 200 });
      fake.hangPs.add('worker-files');
      const t = Date.now();
      const status = await slow.status();
      expect(Date.now() - t).toBeLessThan(2000);
      expect(status.parts).toEqual([
        { service: 'postgres', state: 'running', health: null },
        { service: 'app', state: 'running', health: null },
        { service: 'worker-files', state: 'stuck', health: null },
      ]);
    });

    it('keeps the parts 10 s', async () => {
      await statusOf();
      const reads = fake.calls.filter((c) => c[1] === 'ps').length;
      await statusOf();
      expect(fake.calls.filter((c) => c[1] === 'ps').length).toBe(reads);
    });

    it("an update's end never clears a later update's claim", async () => {
      let entered!: () => void;
      const inAfter = new Promise<void>((r) => { entered = r; });
      let open!: () => void;
      const gate = new Promise<void>((r) => { open = r; });
      service['afterUpdate'] = async () => { entered(); await gate; };
      expect((await call('POST', '/v1/update', release('0.8.0'))).status).toBe(202);
      const first = service['active']!;
      await inAfter;
      // a later update won the slot while the first one's afterUpdate awaits
      const later = new Promise<never>(() => {});
      service['active'] = later;
      open();
      await first.catch(() => undefined);
      expect(service['active']).toBe(later);
      service['active'] = null;
    });

    it('a held update hands its parts to a repair', async () => {
      fake.status.set('worker-files', 'removing');
      fake.share = 'silent';
      const held: UpdateRun = { ...newRun('u1', '0.7.0', '0.8.0', new Date()), status: 'held', held: { cause: 'music_unreachable', parts: ['worker-files'], server: '192.0.2.10' } };
      await service['afterUpdate'](held);
      await service.idle();
      const { repair } = await statusOf();
      expect(repair).toMatchObject({ trigger: 'update', status: 'waiting' });
      // an update that did not end held starts none
      const versions = fake.versions();
      await service['afterUpdate']({ ...held, status: 'succeeded', held: null });
      await service.idle();
      expect(fake.versions()).toBe(versions);
      expect((await statusOf()).repair?.id).toBe(repair?.id);
    });

    describe('after a restart', () => {
      const restart = async () => {
        const s = make();
        await s.load();
        await s.idle();
        return s;
      };

      it('a running repair fails and says to press Repair again', async () => {
        const cut = newRepairRun('rr1', 'owner', new Date());
        cut.steps[0]!.status = 'running';
        await writeRun(REPAIR_STATE_FILE, cut);
        const s = await restart();
        const repair = (await s.status()).repair!;
        expect(repair).toMatchObject({ id: 'rr1', status: 'failed', reason: 'The updater restarted during the repair. Press Repair again.' });
        expect(repair.steps[0]!.status).toBe('failed');
        expect(fake.versions()).toBe(0);
        // the app's audit log gets its end row
        expect(fake.reports).toEqual([{ status: 'failed', cause: null }]);
      });

      it('after a restart, a held update with a part down starts a repair', async () => {
        fake.status.set('worker-files', 'exited');
        await writeRun(join(STATE_DIR, 'state.json'), { ...newRun('u1', '0.7.0', '0.8.0', new Date()), status: 'held', held: { cause: 'music_unreachable', parts: ['worker-files'], server: '192.0.2.10' } });
        const s = await restart();
        expect((await s.status()).repair).toMatchObject({ trigger: 'update', status: 'repaired' });
        expect(fake.status.get('worker-files')).toBe('running');
      });

      it('after a restart, a rollback_failed run with stuck parts starts a repair', async () => {
        fake.status.set('app', 'exited');
        await writeRun(join(STATE_DIR, 'state.json'), { ...newRun('u1', '0.7.0', '0.8.0', new Date()), status: 'rollback_failed', stuck: ['app'] });
        const s = await restart();
        expect((await s.status()).repair).toMatchObject({ trigger: 'update', status: 'repaired' });
        expect(fake.status.get('app')).toBe('running');
      });

      describe('once per interrupted update', () => {
        const heldAt = (finishedAt: Date): UpdateRun => ({ ...newRun('u1', '0.7.0', '0.8.0', new Date(finishedAt.getTime() - 60_000)), status: 'held', finishedAt: finishedAt.toISOString(), held: { cause: 'music_unreachable', parts: ['worker-files'], server: '192.0.2.10' } });
        const repairedAt = (startedAt: Date): RepairRun => ({ ...newRepairRun('rr1', 'update', startedAt), status: 'repaired', finishedAt: new Date(startedAt.getTime() + 60_000).toISOString() });

        it('a held update repaired since gets no second repair, even with a part down', async () => {
          const ended = new Date(Date.now() - 3_600_000);
          await writeRun(join(STATE_DIR, 'state.json'), heldAt(ended));
          await writeRun(REPAIR_STATE_FILE, repairedAt(new Date(ended.getTime() + 1000)));
          fake.status.set('worker-files', 'exited');
          const s = await restart();
          expect((await s.status()).repair?.id).toBe('rr1');
          expect(fake.versions()).toBe(0);
          expect(fake.status.get('worker-files')).toBe('exited');
        });

        it('a held update with only an older repair gets one, once', async () => {
          const ended = new Date(Date.now() - 3_600_000);
          await writeRun(join(STATE_DIR, 'state.json'), heldAt(ended));
          await writeRun(REPAIR_STATE_FILE, repairedAt(new Date(ended.getTime() - 600_000)));
          fake.status.set('worker-files', 'exited');
          const s = await restart();
          const repair = (await s.status()).repair!;
          expect(repair).toMatchObject({ trigger: 'update', status: 'repaired' });
          expect(repair.id).not.toBe('rr1');
          expect(fake.versions()).toBe(1);
          s.stop();
          // the next start finds that repair, so it runs none
          fake.status.set('worker-files', 'exited');
          await restart();
          expect(fake.versions()).toBe(1);
        });

        it('a part that is only starting (a health check at boot) is not down', async () => {
          await writeRun(join(STATE_DIR, 'state.json'), heldAt(new Date(Date.now() - 60_000)));
          fake.status.set('app', 'restarting');
          const s = await restart();
          expect((await s.status()).repair).toBeNull();
          expect(fake.versions()).toBe(0);
        });
      });

      it('a rollback_failed run without stuck parts starts none', async () => {
        fake.status.set('app', 'exited');
        await writeRun(join(STATE_DIR, 'state.json'), { ...newRun('u1', '0.7.0', '0.8.0', new Date()), status: 'rollback_failed' });
        const s = await restart();
        expect((await s.status()).repair).toBeNull();
        expect(fake.versions()).toBe(0);
        expect(fake.status.get('app')).toBe('exited');
      });

      it('no repair when every part runs', async () => {
        await writeRun(join(STATE_DIR, 'state.json'), { ...newRun('u1', '0.7.0', '0.8.0', new Date()), status: 'held', held: { cause: 'music_unreachable', parts: ['worker-files'], server: '192.0.2.10' } });
        const s = await restart();
        expect((await s.status()).repair).toBeNull();
        expect(fake.versions()).toBe(0);
      });

      it('a waiting repair is resumed, not started twice', async () => {
        const waiting = await toWaiting();
        service.stop();
        await writeRun(join(STATE_DIR, 'state.json'), { ...newRun('u1', '0.7.0', '0.8.0', new Date()), status: 'held', held: { cause: 'music_unreachable', parts: ['worker-files'], server: '192.0.2.10' } });
        const s = await restart();
        expect(fake.versions()).toBe(1);
        expect((await s.status()).repair).toMatchObject({ id: waiting.id, status: 'waiting' });
        // its watcher runs again
        expect(s['repair']?.run.id).toBe(waiting.id);
      });
    });
  });

  describe('while it restarts itself on a new version', () => {
    const writeState = async (state: unknown) => {
      await mkdir(join(dir, STATE_DIR), { recursive: true });
      await writeFile(join(dir, STATE_DIR, 'state.json'), JSON.stringify(state));
    };
    const readState = async () => JSON.parse(await readFile(join(dir, STATE_DIR, 'state.json'), 'utf8')) as Record<string, unknown>;
    const finished = () => ({ ...newRun('r1', '0.6.0', '0.7.0', new Date()), status: 'succeeded' });

    it('answers 409 with the version it waits for, and shows the marker in its status', async () => {
      await writeState(finished());
      await service.load();
      await service['selfReplace'].begin('0.8.0', 'r1');
      expect((await readState())['selfReplace']).toMatchObject({ expectedVersion: '0.8.0', fromVersion: '0.7.0', runId: 'r1' });
      const res = await call('POST', '/v1/update', release('0.8.0'));
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string; selfReplace: { expectedVersion: string } };
      expect(body.error).toBe('the updater is restarting itself on version 0.8.0; try again in a minute');
      expect(body.selfReplace.expectedVersion).toBe('0.8.0');
      const status = (await (await call('GET', '/v1/status')).json()) as { selfReplace: { expectedVersion: string } | null };
      expect(status.selfReplace?.expectedVersion).toBe('0.8.0');
      expect((status.selfReplace as { ageMs?: number } | null)?.ageMs).toEqual(expect.any(Number));
    });

    it('the old updater restarted before the hand-over ran keeps refusing while the labelled one-off runs', async () => {
      const { fresh, logs } = await startWith('0.6.0', new Date(), new Date(), 'ho1\n');
      expect(logs[0]).toMatch(/^warn: restarted on 0\.6\.0 while the hand-over to 0\.7\.0 still runs/);
      expect((await readState())['selfReplace']).toMatchObject({ expectedVersion: '0.7.0' });
      expect((await fresh.start('0.7.0', signed(KEY, testManifest('0.7.0')).text, signed(KEY, testManifest('0.7.0')).signature)).ok).toBe(false);
    });

    const startWith = async (version: string, since: Date, now = new Date(), handoverPs = '') => {
      await writeState({ ...finished(), selfReplace: { expectedVersion: '0.7.0', fromVersion: '0.6.0', runId: 'r1', since: since.toISOString() } });
      const logs: string[] = [];
      const fresh = new UpdaterService({
        installDir: dir,
        appSecret: SECRET,
      keys: [KEY.trusted],
        version,
        docker: async (args) => (args.join(' ') === 'ps -q --filter label=tagave.updater.handover' ? { code: 0, stdout: handoverPs, stderr: '' } : { code: 1, stdout: '', stderr: 'no' }),
        app: { health: async () => ({ ok: false, detail: 'down' }), versions: async () => null },
        config: { ...DEFAULT_CONFIG, selfUpdate: false },
        now: () => now,
        log: (level, m) => { logs.push(`${level}: ${m}`); },
      });
      await fresh.load();
      return { fresh, logs };
    };

    it('the replacement on the expected version clears the marker and keeps the run', async () => {
      const { fresh, logs } = await startWith('0.7.0', new Date());
      expect(logs).toEqual(['info: the updater restarted on 0.7.0 as planned']);
      const state = await readState();
      expect(state['selfReplace']).toBeUndefined();
      expect(state['id']).toBe('r1');
      expect((await fresh.status()).selfReplace).toBeNull();
    });

    it('an updater on another version clears the marker with a warning', async () => {
      const { logs } = await startWith('0.6.5', new Date());
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatch(/^warn: the updater was to restart on 0\.7\.0 but runs 0\.6\.5/);
      expect((await readState())['selfReplace']).toBeUndefined();
    });

    it('a marker older than ten minutes is cleared with a warning', async () => {
      const now = new Date();
      const { logs } = await startWith('0.6.0', new Date(now.getTime() - 11 * 60_000), now);
      expect(logs[0]).toMatch(/^warn: found a restart onto 0\.7\.0 .* that never finished/);
      expect((await readState())['selfReplace']).toBeUndefined();
    });
  });
});
