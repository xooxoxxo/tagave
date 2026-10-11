import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { UpdateRun } from '@liner/shared/updater';
import { envGet } from './envFile.js';
import type { AppProbe, CommandResult, Runner } from './runner.js';
import { DEFAULT_CONFIG, IMAGE_DEPLOY_DIR, Update, newRun } from './update.js';

const ENV = `# tagave
COMPOSE_PROJECT_NAME=tagave
COMPOSE_PROFILES=app,files,updater
TAGAVE_ROLE=all
TAGAVE_REGISTRY=ghcr.io/xooxoxxo
TAGAVE_VERSION=0.7.0
APP_SECRET=s3cret
`;
const COMPOSE = 'name: tagave\nservices:\n  app: {}\n';

/**
 * A pretend install: the .env on disk decides which version `up -d` starts,
 * the new app migrates the database when told to, and any step can be made
 * to fail.
 */
class FakeInstall {
  appVersion = '0.7.0';
  appUp = true;
  workers = new Map<string, { version: string; seenAt: number }>();
  migrations = 38;
  calls: string[][] = [];
  /** Versions whose app migrates on start. */
  migratesOn = new Set<string>();
  /** Versions whose app never turns healthy. */
  unhealthy = new Set<string>();
  /** Versions whose workers never start. */
  brokenWorkers = new Set<string>();
  missingTags = new Set<string>();
  failRestore = false;
  restored = false;
  now = Date.parse('2026-10-11T10:00:00Z');

  constructor(readonly dir: string) {
    this.workers.set('w-identify-old', { version: '0.7.0', seenAt: this.now });
    this.workers.set('w-files-old', { version: '0.7.0', seenAt: this.now });
  }

  private async envVersion(override?: Record<string, string>): Promise<string> {
    if (override?.['TAGAVE_VERSION']) return override['TAGAVE_VERSION'];
    return envGet(await readFile(join(this.dir, '.env'), 'utf8'), 'TAGAVE_VERSION')!;
  }

  runner: Runner = async (args, opts) => {
    this.calls.push(args);
    const ok = (stdout = ''): CommandResult => ({ code: 0, stdout, stderr: '' });
    const bad = (stderr: string): CommandResult => ({ code: 1, stdout: '', stderr });
    const a = args.join(' ');
    if (a === 'compose config --services') return ok('postgres\napp\nworker-identify\nworker-files\nupdater\n');
    if (a === 'compose config --quiet') return ok();
    if (args[0] === 'compose' && args[1] === 'pull') {
      const v = await this.envVersion(opts?.env);
      return this.missingTags.has(v) ? bad(`Error response from daemon: manifest for ghcr.io/xooxoxxo/tagave-app:${v} not found: manifest unknown`) : ok();
    }
    if (a.includes('select count(*) from _migrations')) return ok(`${this.migrations}\n`);
    if (a.startsWith('compose exec -T app node packages/doctor/dist/cli.js backup')) {
      return ok(JSON.stringify({ path: '/backups/tagave-manual-20261011.pgdump', tocEntries: 412 }));
    }
    if (args[0] === 'run' && args.includes('cat')) {
      return args.at(-1) === `${IMAGE_DEPLOY_DIR}/compose.yml` ? ok(`${COMPOSE}# new\n`) : bad('No such file');
    }
    if (args[0] === 'compose' && args[1] === 'stop') {
      for (const s of args.slice(2)) {
        if (s === 'app') this.appUp = false;
        if (s.startsWith('worker-')) for (const k of [...this.workers.keys()]) if (k.startsWith(`w-${s.slice(7)}`)) this.workers.delete(k);
      }
      return ok();
    }
    if (args[0] === 'compose' && args[1] === 'up') {
      const v = await this.envVersion();
      const services = args.slice(3);
      if (services.includes('app') && (!this.appUp || this.appVersion !== v)) {
        this.appVersion = v;
        this.appUp = true;
        if (this.migratesOn.has(v)) this.migrations += 1;
      }
      if (services.some((s) => s.startsWith('worker-')) && !this.brokenWorkers.has(v)) {
        for (const s of services.filter((x) => x.startsWith('worker-'))) {
          for (const k of [...this.workers.keys()]) if (k.startsWith(`w-${s.slice(7)}`)) this.workers.delete(k);
          this.workers.set(`w-${s.slice(7)}-${v}`, { version: v, seenAt: this.now + 1 });
        }
      }
      return ok();
    }
    if (a.includes('liner-doctor') || a.includes('cli.js restore')) {
      if (this.failRestore) return bad('pg_restore: error: could not connect');
      this.restored = true;
      this.migrations = 38;
      return ok('{"database":"liner"}');
    }
    if (args[0] === 'compose' && args[1] === 'run') return ok('abc123');
    return bad(`unexpected: docker ${a}`);
  };

  app: AppProbe = {
    health: async () => {
      if (!this.appUp) return { ok: false, detail: 'the app does not answer' };
      if (this.unhealthy.has(this.appVersion)) return { ok: false, detail: 'health answered 503 (database ok, migrations error)' };
      return { ok: true, detail: 'ok' };
    },
    versions: async () => {
      if (!this.appUp) return null;
      return {
        app: this.appVersion,
        workers: [...this.workers.entries()].map(([workerId, w]) => ({ workerId, version: w.version, lastSeenAt: new Date(w.seenAt).toISOString() })),
      };
    },
  };
}

let dir: string;
let fake: FakeInstall;
let saved: UpdateRun[];

async function update(target: string, overrides: Partial<typeof DEFAULT_CONFIG> = {}) {
  let clock = fake.now;
  const u = new Update(
    {
      installDir: dir,
      docker: fake.runner,
      app: fake.app,
      config: { ...DEFAULT_CONFIG, pollMs: 1000, healthTimeoutMs: 30_000, selfUpdate: true, ...overrides },
      save: async (r) => { saved.push(r); },
      now: () => new Date(clock),
      sleep: async (ms) => { clock += ms; },
      freeBytes: async () => 50 * 1024 ** 3,
    },
    newRun('run-1', '0.7.0', target, new Date(clock)),
  );
  return u.execute();
}

const stepStatus = (run: UpdateRun) => Object.fromEntries(run.steps.map((s) => [s.id, s.status]));
const envNow = async () => envGet(await readFile(join(dir, '.env'), 'utf8'), 'TAGAVE_VERSION');

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tagave-updater-'));
  await writeFile(join(dir, '.env'), ENV, { mode: 0o600 });
  await writeFile(join(dir, 'compose.yml'), COMPOSE);
  fake = new FakeInstall(dir);
  saved = [];
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('update state machine', () => {
  it('moves the install to the target and checks every part', async () => {
    const run = await update('0.8.0');
    expect(run.status).toBe('succeeded');
    expect(stepStatus(run)).toEqual({ preflight: 'done', backup: 'done', config: 'done', pull: 'done', restart: 'done', verify: 'done', rollback: 'skipped' });
    expect(await envNow()).toBe('0.8.0');
    expect(envGet(await readFile(join(dir, '.env.bak'), 'utf8'), 'TAGAVE_VERSION')).toBe('0.7.0');
    expect((await stat(join(dir, '.env'))).mode & 0o777).toBe(0o600);
    // the compose file came from the target's updater image
    expect(await readFile(join(dir, 'compose.yml'), 'utf8')).toContain('# new');
    expect(run.backup).toBe('/backups/tagave-manual-20261011.pgdump');
    expect(fake.appVersion).toBe('0.8.0');
    expect([...fake.workers.values()].map((w) => w.version)).toEqual(['0.8.0', '0.8.0']);
    // the target images were pulled with the version overridden before .env changed
    const firstPull = fake.calls.findIndex((c) => c[1] === 'pull');
    const backup = fake.calls.findIndex((c) => c.includes('backup'));
    expect(firstPull).toBeLessThan(backup);
    // the updater is never restarted by the update itself, only replaced at the end by a one-off
    const ups = fake.calls.filter((c) => c[1] === 'up');
    expect(ups.every((c) => !c.includes('updater'))).toBe(true);
    expect(fake.calls.at(-1)!.slice(0, 3)).toEqual(['compose', 'run', '-d']);
    // workers stop before the new app starts, and start after it answers
    const stop = fake.calls.findIndex((c) => c[1] === 'stop');
    const upApp = fake.calls.findIndex((c) => c[1] === 'up' && c[3] === 'app' && c.length === 4);
    expect(stop).toBeLessThan(upApp);
    expect(saved.length).toBeGreaterThan(5);
    expect(saved.at(-1)!.status).toBe('succeeded');
  });

  it('fails at preflight when the target is not published, and changes nothing', async () => {
    fake.missingTags.add('0.8.0');
    const run = await update('0.8.0');
    expect(run.status).toBe('failed');
    expect(run.reason).toMatch(/0\.8\.0 is not published.*Nothing was changed/);
    expect(stepStatus(run)).toMatchObject({ preflight: 'failed', backup: 'skipped', config: 'skipped', rollback: 'skipped' });
    expect(await envNow()).toBe('0.7.0');
    expect(fake.calls.some((c) => c.includes('backup'))).toBe(false);
  });

  it('refuses to start when the install is not healthy now', async () => {
    fake.unhealthy.add('0.7.0');
    const run = await update('0.8.0');
    expect(run.status).toBe('failed');
    expect(run.reason).toMatch(/not healthy now/);
  });

  it('refuses when there is not enough disk', async () => {
    const run = await update('0.8.0', { minFreeBytes: 100 * 1024 ** 3 });
    expect(run.status).toBe('failed');
    expect(run.reason).toMatch(/GB free for Docker/);
  });

  it('rolls back without a restore when the new app never turns healthy and changed nothing', async () => {
    fake.unhealthy.add('0.8.0');
    const run = await update('0.8.0');
    expect(run.status).toBe('rolled_back');
    expect(stepStatus(run)).toMatchObject({ restart: 'failed', verify: 'skipped', rollback: 'done' });
    expect(run.reason).toMatch(/did not answer healthy on 0\.8\.0/);
    expect(run.rollback).toEqual({ version: '0.7.0', restoredDatabase: false, healthy: true });
    expect(fake.restored).toBe(false);
    expect(await envNow()).toBe('0.7.0');
    expect(await readFile(join(dir, 'compose.yml'), 'utf8')).toBe(COMPOSE);
    expect(fake.appVersion).toBe('0.7.0');
    expect([...fake.workers.values()].map((w) => w.version)).toEqual(['0.7.0', '0.7.0']);
  });

  it('restores the backup when the failed version had migrated the database', async () => {
    fake.migratesOn.add('0.8.0');
    fake.brokenWorkers.add('0.8.0');
    const run = await update('0.8.0');
    expect(run.status).toBe('rolled_back');
    expect(stepStatus(run)).toMatchObject({ restart: 'done', verify: 'failed', rollback: 'done' });
    expect(run.reason).toMatch(/0 of 2 workers report 0\.8\.0/);
    expect(run.rollback).toEqual({ version: '0.7.0', restoredDatabase: true, healthy: true });
    expect(fake.restored).toBe(true);
    const restore = fake.calls.find((c) => c.includes('restore'))!;
    expect(restore).toEqual(['compose', 'run', '--rm', '--no-deps', '-T', 'app', 'node', 'packages/doctor/dist/cli.js', 'restore', '/backups/tagave-manual-20261011.pgdump', '--yes', '--json']);
    // the app and workers were stopped before the restore, and .env pointed at the old version
    const restoreIdx = fake.calls.indexOf(restore);
    const stopIdx = fake.calls.findLastIndex((c, i) => i < restoreIdx && c[1] === 'stop');
    expect(fake.calls[stopIdx]).toEqual(['compose', 'stop', 'app', 'worker-identify', 'worker-files']);
    expect(await envNow()).toBe('0.7.0');
    expect(fake.migrations).toBe(38);
    expect(fake.appVersion).toBe('0.7.0');
  });

  it('fails at pull after the config switch, and rolls back without a restore', async () => {
    let pulls = 0;
    const inner = fake.runner;
    fake.runner = async (args, opts) => {
      if (args[1] === 'pull' && ++pulls === 2) return { code: 1, stdout: '', stderr: 'net/http: TLS handshake timeout' };
      return inner(args, opts);
    };
    const run = await update('0.8.0');
    expect(run.status).toBe('rolled_back');
    expect(stepStatus(run)).toMatchObject({ config: 'done', pull: 'failed', restart: 'skipped', rollback: 'done' });
    expect(run.rollback?.restoredDatabase).toBe(false);
    expect(await envNow()).toBe('0.7.0');
  });

  it('reports a roll back that could not finish', async () => {
    fake.migratesOn.add('0.8.0');
    fake.brokenWorkers.add('0.8.0');
    fake.failRestore = true;
    const run = await update('0.8.0');
    expect(run.status).toBe('rollback_failed');
    expect(run.reason).toMatch(/liner-doctor restore failed/);
    expect(run.log.at(-1)!.message).toMatch(/by hand/);
    expect(await envNow()).toBe('0.7.0');
  });
});
