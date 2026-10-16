import { mkdtemp, readFile, rm, writeFile, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ModuleRun } from '@tagave/shared/modules';
import { envGet } from './envFile.js';
import { ModuleOperation, moduleStatuses, newModuleRun, renderModuleCompose, withComposeFile, type ModuleConfig } from './modules.js';
import { verifyRelease, type VerifiedRelease } from './release.js';
import { digest, signed, testKey, testManifest } from './release.testkit.js';
import type { CommandResult, RunOptions } from './runner.js';

const KEY = testKey();
const PLATFORM = 'linux/arm64';
const CONFIG: ModuleConfig = { minFreeBytes: 1024 ** 3, healthTimeoutMs: 50, moduleHealthTimeoutMs: 50, pollMs: 1, commandTimeoutMs: 1000 };
const ENV = [
  'COMPOSE_PROJECT_NAME=t1',
  'COMPOSE_FILE=compose.yml',
  'COMPOSE_PROFILES=app,files,updater',
  'TAGAVE_ROLE=all',
  'TAGAVE_VERSION=0.10.0',
  'TAGAVE_PORT=3100',
  'APP_SECRET=s',
  '',
].join('\n');

function release(version = '0.10.0'): VerifiedRelease {
  const { text, signature } = signed(KEY, testManifest(version));
  return verifyRelease(text, signature, [KEY.trusted], { version });
}

interface FakeOptions {
  /** RepoDigests docker reports after a pull: by default the digest asked for. */
  pulledDigest?: (ref: string, wanted: string) => string;
  unhealthy?: string[];
  failUp?: string[];
  pullFails?: boolean;
  freeBytes?: number;
}

/** A Docker that keeps the little state these runs need, reading .env and modules/*.yml like compose would. */
function fakeDocker(dir: string, o: FakeOptions = {}) {
  const calls: string[] = [];
  const running = new Set<string>(['app', 'postgres']);
  const docker = async (args: string[], _opts?: RunOptions): Promise<CommandResult> => {
    const line = args.join(' ');
    calls.push(line);
    const ok = (stdout = ''): CommandResult => ({ code: 0, stdout, stderr: '' });
    const no = (stderr: string): CommandResult => ({ code: 1, stdout: '', stderr });
    const env = (await readFile(join(dir, '.env'), 'utf8').catch(() => '')) as string;
    let a = args;
    if (a[0] === 'compose') {
      a = a.slice(1);
      if (a[0] === '--profile') a = a.slice(2);
      if (a[0] === 'config' && a[1] === '--services') return ok('postgres\napp\nworker-identify\nworker-files\nupdater\nplayer\n');
      if (a[0] === 'config' && a[1] === '--quiet') return ok();
      if (a[0] === 'config' && a[1] === '--format') {
        const services: Record<string, { image: string }> = {};
        const pin = envGet(env, 'TAGAVE_DIGEST_PLAYER');
        if ((envGet(env, 'COMPOSE_PROFILES') ?? '').includes('player')) services['player'] = { image: `deluan/navidrome:0.64.0${pin ? `@${pin}` : ''}` };
        for (const f of (envGet(env, 'COMPOSE_FILE') ?? '').split(':')) {
          if (!f.startsWith('modules/')) continue;
          const text = await readFile(join(dir, f), 'utf8');
          const doc = JSON.parse(text.slice(text.indexOf('{'))) as { services: Record<string, { image: string }> };
          Object.assign(services, doc.services);
        }
        return ok(JSON.stringify({ services }));
      }
      if (a[0] === 'up') {
        const names = a.slice(2);
        const bad = names.find((n) => o.failUp?.includes(n));
        if (bad) return no(`Error: ${bad}: port is already allocated`);
        for (const n of names) running.add(n);
        return ok();
      }
      if (a[0] === 'rm') {
        for (const n of a.slice(3)) running.delete(n);
        return ok();
      }
      if (a[0] === 'ps') return ok(running.has(a[2]!) ? `cid-${a[2]}\n` : '');
      if (a[0] === 'exec') return no('not here');
    }
    if (a[0] === 'inspect') {
      const name = a.at(-1)!.replace(/^cid-/, '');
      return ok(o.unhealthy?.includes(name) ? 'unhealthy' : 'healthy');
    }
    if (a[0] === 'info') return ok('/var/lib/docker\n');
    if (a[0] === 'pull') return o.pullFails ? no('Error: manifest unknown') : ok();
    if (a[0] === 'image' && a[1] === 'inspect') {
      const ref = a.at(-1)!;
      if (a.includes('{{.Id}}')) return no('No such image');
      const [repo, wanted] = ref.split('@') as [string, string];
      const got = o.pulledDigest ? o.pulledDigest(ref, wanted) : wanted;
      return ok(JSON.stringify([`${repo.replace(/:[^/:]+$/, '')}@${got}`]));
    }
    if (a[0] === 'tag') return ok();
    if (a[0] === 'volume' && a[1] === 'ls') {
      const vol = /com\.docker\.compose\.volume=(.+)$/.exec(line)?.[1];
      return ok(`t1_${vol}\n`);
    }
    if (a[0] === 'volume' && a[1] === 'rm') return ok();
    return no(`fake docker does not know: ${line}`);
  };
  return { docker, calls, running };
}

describe('module operations', () => {
  let dir: string;
  let saved: ModuleRun[];
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tagave-modules-'));
    await writeFile(join(dir, '.env'), ENV);
    await writeFile(join(dir, 'compose.yml'), 'services: {}\n');
    saved = [];
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const op = (module: string, action: 'enable' | 'disable', fake: ReturnType<typeof fakeDocker>, extra: { deleteData?: boolean; release?: VerifiedRelease } = {}) => {
    const rel = extra.release ?? release();
    const entry = rel.manifest.modules.find((m) => m.id === module)!;
    let n = 0;
    return new ModuleOperation(
      {
        installDir: dir,
        docker: fake.docker,
        app: { health: async () => ({ ok: true, detail: 'ok' }), versions: async () => null },
        config: CONFIG,
        release: rel,
        platform: PLATFORM,
        save: async (r) => { saved.push(r); },
        statfs: async () => ({ bavail: (fakeFree ?? 100 * 1024 ** 3) / 4096, bsize: 4096, blocks: 1e9 }),
        layers: async () => [{ digest: digest('9'), size: 50 * 1024 ** 2 }],
        sleep: async () => undefined,
        secret: () => `secret${(n += 1)}`,
      },
      newModuleRun('run1', entry, action, rel.manifest.version, extra.deleteData ?? false, new Date()),
    );
  };
  let fakeFree: number | undefined;
  beforeEach(() => { fakeFree = undefined; });
  const env = async () => readFile(join(dir, '.env'), 'utf8');

  it('turns the player on: secrets once, pins, profile, app restarted, healthy', async () => {
    const fake = fakeDocker(dir);
    const run = await op('player', 'enable', fake).execute();
    expect(run.status).toBe('succeeded');
    expect(run.steps.map((s) => `${s.id}:${s.status}`)).toEqual(['preflight:done', 'config:done', 'start:done', 'verify:done', 'rollback:skipped']);
    const e = await env();
    expect(envGet(e, 'COMPOSE_PROFILES')).toBe('app,files,updater,player');
    expect(envGet(e, 'TAGAVE_PLAYER_PASSWORD')).toBe('secret1');
    expect(envGet(e, 'TAGAVE_PLAYER_ENCRYPTION_KEY')).toBe('secret2');
    expect(envGet(e, 'TAGAVE_PLAYER_URL')).toBe('http://player:4533');
    expect(envGet(e, 'TAGAVE_PLAYER_PORT')).toBe('4533');
    expect(envGet(e, 'TAGAVE_DIGEST_PLAYER')).toBe(digest('e2'));
    expect(fake.calls).toContain(`pull deluan/navidrome:0.64.0@${digest('e2')}`);
    // pulled before anything in .env changed; started, then the app restarted
    const pullAt = fake.calls.findIndex((c) => c.startsWith('pull'));
    const upAt = fake.calls.indexOf('compose up -d player');
    expect(pullAt).toBeGreaterThan(-1);
    expect(upAt).toBeGreaterThan(pullAt);
    expect(fake.calls.indexOf('compose up -d app')).toBeGreaterThan(upAt);
    expect(await readFile(join(dir, '.env.bak'), 'utf8')).toBe(ENV);
  });

  it('keeps existing secrets when the player is turned on again', async () => {
    await writeFile(join(dir, '.env'), `${ENV}TAGAVE_PLAYER_PASSWORD=old\nTAGAVE_PLAYER_PORT=4600\n`);
    const run = await op('player', 'enable', fakeDocker(dir)).execute();
    expect(run.status).toBe('succeeded');
    expect(envGet(await env(), 'TAGAVE_PLAYER_PASSWORD')).toBe('old');
    expect(envGet(await env(), 'TAGAVE_PLAYER_PORT')).toBe('4600');
  });

  it('refuses before changing anything when the pulled digest differs from the manifest', async () => {
    const fake = fakeDocker(dir, { pulledDigest: () => digest('7') });
    const run = await op('player', 'enable', fake).execute();
    expect(run.status).toBe('failed');
    expect(run.reason).toMatch(/not sha256:(e2)+ as the signed manifest pins.*Nothing was changed\./);
    expect(await env()).toBe(ENV);
    expect(fake.calls.some((c) => c.startsWith('compose up'))).toBe(false);
  });

  it('refuses a port the web app uses, a split install, the file worker, and a module that is on already', async () => {
    await writeFile(join(dir, '.env'), `${ENV}TAGAVE_PLAYER_PORT=3100\n`);
    expect((await op('player', 'enable', fakeDocker(dir)).execute()).reason).toMatch(/port 3100.*the web app/);
    await writeFile(join(dir, '.env'), ENV.replace('TAGAVE_ROLE=all', 'TAGAVE_ROLE=app'));
    expect((await op('player', 'enable', fakeDocker(dir)).execute()).reason).toMatch(/needs everything on one computer/);
    expect((await op('dummy', 'enable', fakeDocker(dir)).execute()).status).toBe('succeeded');
    await writeFile(join(dir, '.env'), ENV.replace('TAGAVE_ROLE=all', 'TAGAVE_ROLE=files'));
    expect((await op('dummy', 'enable', fakeDocker(dir)).execute()).reason).toMatch(/only the file worker/);
    await writeFile(join(dir, '.env'), ENV.replace('app,files,updater', 'app,files,updater,player'));
    expect((await op('player', 'enable', fakeDocker(dir)).execute()).reason).toMatch(/on already/);
  });

  it('refuses when the disk cannot take its images', async () => {
    fakeFree = 1.1 * 1024 ** 3;
    const run = await op('player', 'enable', fakeDocker(dir)).execute();
    expect(run.status).toBe('failed');
    expect(run.reason).toMatch(/not enough free disk space.*turning on Player needs/);
  });

  it('rolls back when the module does not come up healthy: containers removed, .env as before, app restarted', async () => {
    const fake = fakeDocker(dir, { unhealthy: ['player'] });
    const run = await op('player', 'enable', fake).execute();
    expect(run.status).toBe('rolled_back');
    expect(run.reason).toMatch(/Player did not report healthy within 0 s: player reports unhealthy/);
    expect(run.steps.find((s) => s.id === 'verify')!.status).toBe('failed');
    expect(run.steps.find((s) => s.id === 'rollback')!.status).toBe('done');
    expect(await env()).toBe(ENV);
    expect(fake.running.has('player')).toBe(false);
    const rollbackAt = fake.calls.lastIndexOf('compose --profile player rm --stop --force player');
    expect(fake.calls.lastIndexOf('compose up -d app')).toBeGreaterThan(rollbackAt);
  });

  it('rolls back when compose cannot start it', async () => {
    const run = await op('player', 'enable', fakeDocker(dir, { failUp: ['player'] })).execute();
    expect(run.status).toBe('rolled_back');
    expect(run.reason).toMatch(/could not start Player: Error: player: port is already allocated/);
    expect(await env()).toBe(ENV);
  });

  it('turns a module with its own compose file on and off, keeping its data unless asked', async () => {
    const fake = fakeDocker(dir);
    expect((await op('dummy', 'enable', fake).execute()).status).toBe('succeeded');
    let e = await env();
    expect(envGet(e, 'COMPOSE_FILE')).toBe('compose.yml:modules/dummy.yml');
    expect(envGet(e, 'COMPOSE_PROFILES')).toBe('app,files,updater,dummy');
    expect(envGet(e, 'TAGAVE_MODULE_DUMMY_TOKEN')).toBe('secret1');
    const file = await readFile(join(dir, 'modules/dummy.yml'), 'utf8');
    expect(file).toContain(`"image": "example.test/tagave-dummy:1.0@${digest('f2')}"`);
    expect(file).toContain('"profiles": [\n        "dummy"');

    const off = await op('dummy', 'disable', fake).execute();
    expect(off.status).toBe('succeeded');
    expect(off.steps.find((s) => s.id === 'data')!.status).toBe('skipped');
    expect(off.log.some((l) => /kept its data: t1_dummy-data/.test(l.message))).toBe(true);
    e = await env();
    expect(envGet(e, 'COMPOSE_FILE')).toBe('compose.yml');
    expect(envGet(e, 'COMPOSE_PROFILES')).toBe('app,files,updater');
    expect(envGet(e, 'TAGAVE_MODULE_DUMMY_TOKEN')).toBe('secret1');
    await expect(stat(join(dir, 'modules/dummy.yml'))).rejects.toThrow();
    expect(fake.calls.some((c) => c.startsWith('volume rm'))).toBe(false);
  });

  it('turns the player off and deletes its data only when ticked; the URL cleared, the secrets kept', async () => {
    const fake = fakeDocker(dir);
    await op('player', 'enable', fake).execute();
    const off = await op('player', 'disable', fake, { deleteData: true }).execute();
    expect(off.status).toBe('succeeded');
    expect(off.steps.map((s) => `${s.id}:${s.status}`)).toEqual(['preflight:done', 'stop:done', 'config:done', 'verify:done', 'data:done', 'rollback:skipped']);
    const e = await env();
    expect(envGet(e, 'TAGAVE_PLAYER_URL')).toBe('');
    expect(envGet(e, 'TAGAVE_PLAYER_PASSWORD')).toBe('secret1');
    expect(fake.calls).toContain('volume rm t1_player-data');
    expect(fake.calls.indexOf('volume rm t1_player-data')).toBeGreaterThan(fake.calls.lastIndexOf('compose up -d app'));
  });

  it('rolls a Turn off back when the app does not come back, and never deletes data then', async () => {
    const fake = fakeDocker(dir);
    await op('player', 'enable', fake).execute();
    const before = await env();
    const failing = fakeDocker(dir, { failUp: ['app'] });
    const off = await op('player', 'disable', failing, { deleteData: true }).execute();
    expect(off.status).toBe('rollback_failed');
    expect(await env()).toBe(before);
    expect(failing.calls.some((c) => c.startsWith('volume rm'))).toBe(false);
  });

  it('refuses to turn off what is not on', async () => {
    const run = await op('player', 'disable', fakeDocker(dir)).execute();
    expect(run.status).toBe('failed');
    expect(run.reason).toBe('Player is not on. Nothing was changed.');
  });

  it('reports each module state from .env, the run and the pins', async () => {
    const rel = release();
    const statuses = async (run: ModuleRun | null, active = false) =>
      Object.fromEntries((await moduleStatuses({ installDir: dir, release: rel, platform: PLATFORM, run, active })).map((m) => [m.id, m.state]));
    expect(await statuses(null)).toEqual({ player: 'off', dummy: 'off' });
    const failed = { ...newModuleRun('r', rel.manifest.modules[0]!, 'enable', '0.10.0', false, new Date()), status: 'rolled_back' as const, reason: 'x' };
    expect(await statuses(failed)).toEqual({ player: 'failed', dummy: 'off' });
    const running = { ...failed, status: 'running' as const };
    expect(await statuses(running, true)).toEqual({ player: 'installing', dummy: 'off' });
    await writeFile(join(dir, '.env'), `${ENV.replace('app,files,updater', 'app,files,updater,player')}TAGAVE_DIGEST_PLAYER=${digest('e2')}\n`);
    expect(await statuses(null)).toEqual({ player: 'on', dummy: 'off' });
    await writeFile(join(dir, '.env'), `${ENV.replace('app,files,updater', 'app,files,updater,player')}TAGAVE_DIGEST_PLAYER=${digest('e0')}\n`);
    expect(await statuses(null)).toEqual({ player: 'update_pending', dummy: 'off' });
    await writeFile(join(dir, '.env'), ENV.replace('TAGAVE_ROLE=all', 'TAGAVE_ROLE=app'));
    const split = await moduleStatuses({ installDir: dir, release: rel, platform: PLATFORM, run: null, active: false });
    expect(split.find((m) => m.id === 'player')).toMatchObject({ available: false, reason: expect.stringMatching(/split install/) });
    expect(split.find((m) => m.id === 'dummy')).toMatchObject({ available: true });
  });
});

describe('compose file helpers', () => {
  it('adds and removes a module file in COMPOSE_FILE, compose.yml when it was unset', () => {
    expect(withComposeFile('A=1\n', 'modules/x.yml', true)).toBe('A=1\nCOMPOSE_FILE=compose.yml:modules/x.yml\n');
    expect(withComposeFile('COMPOSE_FILE=compose.yml:compose.db-published.yml\n', 'modules/x.yml', true)).toBe('COMPOSE_FILE=compose.yml:compose.db-published.yml:modules/x.yml\n');
    expect(withComposeFile('COMPOSE_FILE=compose.yml:modules/x.yml\n', 'modules/x.yml', false)).toBe('COMPOSE_FILE=compose.yml\n');
  });

  it('renders a module compose file pinned for the platform', () => {
    const rel = release();
    const text = renderModuleCompose(rel.manifest, rel.manifest.modules[1]!, 'linux/amd64');
    const doc = JSON.parse(text.slice(text.indexOf('{'))) as { services: Record<string, { image: string; profiles: string[] }>; volumes: unknown };
    expect(doc.services['dummy']).toMatchObject({ image: `example.test/tagave-dummy:1.0@${digest('f1')}`, profiles: ['dummy'] });
    expect(doc.volumes).toEqual({ 'dummy-data': null });
  });
});

describe('module runs through the updater service', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tagave-modsrv-'));
    await writeFile(join(dir, '.env'), ENV);
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const service = async () => {
    const { UpdaterService } = await import('./server.js');
    const { DEFAULT_CONFIG } = await import('./update.js');
    const fake = fakeDocker(dir);
    return new UpdaterService({
      installDir: dir,
      appSecret: 'a'.repeat(44),
      version: '0.10.0',
      keys: [KEY.trusted],
      arch: 'arm64',
      docker: fake.docker,
      app: { health: async () => ({ ok: true, detail: 'ok' }), versions: async () => null },
      config: { ...DEFAULT_CONFIG, selfUpdate: false, pollMs: 1, healthTimeoutMs: 50, playerHealthTimeoutMs: 50 },
    });
  };

  it('refuses modules until the signed manifest of the running release is here, then lists them', async () => {
    const svc = await service();
    const before = await svc.modules();
    expect(before).toMatchObject({ version: '0.10.0', verified: false, modules: [] });
    expect(await svc.startModule('player', 'enable', false)).toMatchObject({ ok: false, status: 422 });
    const old = signed(KEY, testManifest('0.9.0'));
    expect(await svc.acceptRelease(old.text, old.signature)).toMatchObject({ ok: false, status: 422, check: 'version' });
    const tampered = signed(KEY, testManifest('0.10.0'));
    expect(await svc.acceptRelease(tampered.text.replace('Player', 'Pl4yer'), tampered.signature)).toMatchObject({ ok: false, check: 'signature' });
    const good = signed(KEY, testManifest('0.10.0'));
    expect(await svc.acceptRelease(good.text, good.signature)).toEqual({ ok: true });
    const after = await svc.modules();
    expect(after.verified).toBe(true);
    expect(after.modules.map((m) => `${m.id}:${m.state}`)).toEqual(['player:off', 'dummy:off']);
    expect(await svc.startModule('nope', 'enable', false)).toMatchObject({ ok: false, status: 404 });
  });

  it('runs one thing at a time, and waits while the updater replaces itself', async () => {
    const svc = await service();
    const good = signed(KEY, testManifest('0.10.0'));
    await svc.acceptRelease(good.text, good.signature);
    const first = await svc.startModule('dummy', 'enable', false);
    expect(first.ok).toBe(true);
    expect(await svc.startModule('player', 'enable', false)).toMatchObject({ ok: false, status: 409, error: 'Dummy is being turned on' });
    const upd = signed(KEY, testManifest('0.11.0'));
    expect(await svc.start('0.11.0', upd.text, upd.signature)).toMatchObject({ ok: false, status: 409 });
    await svc.idle();
    expect((await svc.modules()).modules.find((m) => m.id === 'dummy')!.state).toBe('on');
    await svc['selfReplace'].begin('0.11.0', 'r1');
    const refused = await svc.startModule('dummy', 'disable', false);
    expect(refused).toMatchObject({ ok: false, status: 409, error: expect.stringMatching(/restarting itself on version 0\.11\.0/) });
  });

  it('marks a module run cut off by a restart as interrupted', async () => {
    const svc = await service();
    const rel = release();
    const run = newModuleRun('m1', rel.manifest.modules[0]!, 'enable', '0.10.0', false, new Date());
    run.steps[1]!.status = 'running';
    await mkdir(join(dir, '.updater'), { recursive: true });
    await writeFile(join(dir, '.updater', 'module-run.json'), JSON.stringify(run));
    await svc.load();
    const m = await svc.modules();
    expect(m.run).toMatchObject({ status: 'interrupted', reason: expect.stringMatching(/Add its settings/) });
  });
});
