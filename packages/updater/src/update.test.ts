import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { UpdateRun } from '@tagave/shared/updater';
import { envGet } from './envFile.js';
import type { Layer } from './preflight-space.js';
import type { AppProbe, CommandResult, Runner } from './runner.js';
import { DEFAULT_CONFIG, IMAGE_DEPLOY_DIR, Update, newRun, type UpdateDeps } from './update.js';
import { SelfReplaceGate, parseState, serializeState } from './self-replace.js';
import { verifyRelease } from './release.js';
import { digest, signed, testKey, testManifest } from './release.testkit.js';

const ENV = `# tagave
COMPOSE_PROJECT_NAME=tagave
COMPOSE_PROFILES=app,files,updater
TAGAVE_ROLE=all
TAGAVE_REGISTRY=ghcr.io/xooxoxxo
TAGAVE_VERSION=0.7.0
APP_SECRET=s3cret
`;
const COMPOSE = 'name: tagave\nservices:\n  app: {}\n';
const GB = 1024 ** 3;
const MB = 1024 ** 2;

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
  /** _migration_backups: what the app records before it migrates (null: the table does not exist yet). */
  backupRows: Array<{ id: number; status: string; path: string | null; to: string }> | null = [];
  /** psql in the postgres container fails (the database does not answer). */
  psqlFails = false;
  /** Versions whose app migrates without recording its backup (as if the record were lost). */
  migratesUnrecorded = new Set<string>();
  /** Dumps pg_restore --list can read. */
  dumps = new Set<string>(['/backups/tagave-manual-20261011.pgdump']);
  /** The running app's doctor is from before --kind. */
  oldDoctor = false;
  /** TAGAVE_SKIP_PREMIGRATE_BACKUP reaches the app. */
  skipPremigrate = false;
  /** What the restore was given. */
  restoredFrom: string | null = null;
  /** Versions whose app commits a migration (and records its dump) as it is stopped. */
  commitsOnStop = new Set<string>();
  /** Migration files in the target's app image (null: ls fails), and the ones applied. */
  imageMigrations: string[] | null = ['0044_player_people.sql', '0045_player_retired_accounts.sql'];
  appliedMigrations = ['0044_player_people.sql', '0045_player_retired_accounts.sql'];
  /** What images.thumb_bytes holds. */
  thumbBytes = 0;
  /** docker inspect of a service's container, per call (the last one repeats), and its log. */
  containers = new Map<string, { states: object[]; restarts: number[]; logs: string; calls: number }>();
  /** The install runs the player (compose service "player", Navidrome). */
  withPlayer = false;
  /** What the target's updater image ships as compose.yml. */
  newCompose = `${COMPOSE}# new\n`;
  playerImage: string | null = null;
  playerHealth = 'healthy';
  failSnapshot = false;
  playerSnapshots = 0;
  playerRestored = false;
  now = Date.parse('2026-10-11T10:00:00Z');
  /** Local images, as repository:tag. */
  images: string[] = [];
  imageLsFails = false;
  /** Runs while the one-off container that replaces the updater starts. */
  onReplaceSelf: (() => Promise<void>) | null = null;
  replaceSelfResult: CommandResult = { code: 0, stdout: 'ho1\n', stderr: '' };
  /** `ps -aq --filter label=…` finds the hand-over container. */
  handoverListed = false;
  /** What `docker wait` on it answers; by default it never returns (the replacement kills this process first). */
  handoverExit: Promise<CommandResult> = new Promise(() => undefined);
  waitedOn: string[] = [];
  runningUpdaterImage = 'sha256:old';
  updaterImageIds = new Map<string, string>();
  /** Free bytes Docker's filesystem reports, one per statfs call (the last one repeats). */
  dockerFree: number[] = [50 * GB];
  statfsCalls = 0;
  /** The newest dump the app container finds in /backups, and that folder's disk (same size as Docker's: one filesystem). */
  newestBackup: { name: string; bytes: number } | null = { name: 'tagave-2026-10-10T03-00-00Z-nightly.pgdump', bytes: 700 * MB };
  backupsDisk: { free: number; total: number } | null = null;
  /** Images already on this computer. */
  localImages = new Set(['ghcr.io/xooxoxxo/tagave-app:0.7.0', 'ghcr.io/xooxoxxo/tagave-worker:0.7.0', 'ghcr.io/xooxoxxo/tagave-updater:0.7.0', 'postgres:17']);

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
    if (a === 'compose config --services') return ok(`postgres\napp\nworker-identify\nworker-files\n${this.withPlayer ? 'player\n' : ''}updater\n`);
    if (a === 'compose config --images player') {
      const m = /navidrome:(\S+)/.exec(await readFile(join(this.dir, 'compose.yml'), 'utf8'));
      return ok(`deluan/navidrome:${m?.[1] ?? 'none'}\n`);
    }
    if (a.startsWith('compose run --rm --no-deps -T --entrypoint sh player -c')) {
      const script = args.at(-1)!;
      if (script.includes('cp -a /data/navidrome /data/snapshots/pre-update')) {
        if (this.failSnapshot) return bad('cp: write error: No space left on device');
        this.playerSnapshots += 1;
        return ok('saved\n');
      }
      if (script.includes('cp -a /data/snapshots/pre-update /data/navidrome')) {
        this.playerRestored = true;
        return ok('restored\n');
      }
    }
    // The updater's own container and image, and the target's updater image.
    if (a === 'compose ps -q updater') return ok('upd1\n');
    if (a === 'inspect -f {{.Image}} upd1') return ok(`${this.runningUpdaterImage}\n`);
    if (a === 'compose config --images updater') return ok(`ghcr.io/xooxoxxo/tagave-updater:${await this.envVersion()}\n`);
    if (args[0] === 'image' && args[1] === 'inspect' && args[2] === '-f' && args[3] === '{{.Id}}') {
      return ok(`${this.updaterImageIds.get(args[4]!) ?? 'sha256:new'}\n`);
    }
    if (a.startsWith('ps -aq --filter label=tagave.updater.handover=')) return ok(this.handoverListed ? 'ho1\n' : '');
    if (args[0] === 'wait') {
      this.waitedOn.push(args[1]!);
      return this.handoverExit;
    }
    if (a.startsWith('compose ps -a -q ')) return ok(this.containers.has(args[4]!) ? `${args[4]}-c1\n` : '');
    if (args[0] === 'inspect' && args[2] === '{{json .State}}|{{.RestartCount}}') {
      const c = this.containers.get(args[3]!.replace(/-c1$/, ''));
      if (!c) return bad('No such object');
      const n = c.calls++;
      return ok(`${JSON.stringify(c.states[Math.min(n, c.states.length - 1)])}|${c.restarts[Math.min(n, c.restarts.length - 1)]}\n`);
    }
    if (args[0] === 'logs' && args[1] === '--tail') return ok(this.containers.get(args[3]!.replace(/-c1$/, ''))?.logs ?? '');
    if (args[0] === 'logs') return ok('Error response from daemon: pull access denied\n');
    if (a === 'compose ps -q player') return ok(this.playerImage ? 'pl1\n' : '');
    if (args[0] === 'inspect' && args.at(-1) === 'pl1') return ok(`${this.playerHealth}\n`);
    if (a === 'compose config --quiet') return ok();
    if (a === 'compose config --images') {
      const v = await this.envVersion(opts?.env);
      return ok(`postgres:17\n${['app', 'worker', 'updater'].map((n) => `ghcr.io/xooxoxxo/tagave-${n}:${v}`).join('\n')}\n`);
    }
    if (args[0] === 'image' && args[1] === 'inspect' && (args.includes('{{.Id}}') || args.includes('{{json .RepoDigests}}'))) {
      const ref = args.at(-1)!;
      if (!this.localImages.has(ref)) return bad('No such image');
      return args.includes('{{json .RepoDigests}}') ? ok(`${JSON.stringify([`${ref.replace(/:[^:/]+$/, '')}@sha256:pulled-${ref}`])}\n`) : ok('sha256:x\n');
    }
    if (args[0] === 'info') return ok('/var/lib/docker\n');
    if (a.startsWith('compose exec -T app node -e')) {
      const free = this.dockerFree[Math.min(this.statfsCalls, this.dockerFree.length) - 1] ?? 0;
      return ok(`${JSON.stringify({ dir: '/backups', newest: this.newestBackup, disk: this.backupsDisk ?? { free, total: 100 * GB } })}\n`);
    }
    if (args[0] === 'compose' && args[1] === 'pull') {
      const v = await this.envVersion(opts?.env);
      if (this.missingTags.has(v)) return bad(`Error response from daemon: manifest for ghcr.io/xooxoxxo/tagave-app:${v} not found: manifest unknown`);
      for (const n of ['app', 'worker', 'updater']) this.localImages.add(`ghcr.io/xooxoxxo/tagave-${n}:${v}`);
      return ok();
    }
    if (a.startsWith('compose exec -T postgres') && this.psqlFails) return bad('service "postgres" is not running');
    if (a.includes('select count(*) from _migrations')) return ok(`${this.migrations}\n`);
    if (a.includes('select name from _migrations')) return ok(`${this.appliedMigrations.join('\n')}\n`);
    if (a.includes('sum(octet_length(thumb_bytes))')) return ok(`${this.thumbBytes}\n`);
    if (a === 'compose config --images app') return ok(`ghcr.io/xooxoxxo/tagave-app:${await this.envVersion(opts?.env)}\n`);
    if (args[0] === 'run' && args.includes('ls') && args.at(-1) === '/app/packages/db/migrations') {
      return this.imageMigrations ? ok(`${this.imageMigrations.join('\n')}\n`) : bad('ls: cannot access');
    }
    if (a.includes("to_regclass('public._migration_backups')")) return ok(this.backupRows ? 't\n' : 'f\n');
    if (a.includes('select max(id) from _migration_backups')) {
      const rows = this.backupRows ?? [];
      const last = rows.at(-1);
      return ok(`${rows.reduce((m, r) => Math.max(m, r.id), 0)}|${last ? `${last.status}|${last.to}` : '|'}\n`);
    }
    if (a.includes("where status = 'ok' and path is not null order by id desc limit 1")) {
      return ok(`${[...(this.backupRows ?? [])].reverse().find((r) => r.status === 'ok' && r.path)?.path ?? ''}\n`);
    }
    const since = /where id > (\d+) order by id limit 1/.exec(a);
    if (since) {
      const row = (this.backupRows ?? []).find((r) => r.id > Number(since[1]));
      return ok(row ? `${row.id}|${row.status}|${row.path ?? ''}\n` : '');
    }
    if (a.startsWith('compose run --rm --no-deps -T --entrypoint pg_restore app --list')) {
      return this.dumps.has(args.at(-1)!) ? ok('; Archive created at …\n1; 2615 2200 SCHEMA - public\n') : bad(`pg_restore: error: could not open input file "${args.at(-1)}": No such file or directory`);
    }
    if (a.startsWith('compose exec -T app node packages/doctor/dist/cli.js backup')) {
      if (this.oldDoctor && args.includes('--kind')) return bad('ERROR: unknown option --kind; usage: backup [--out DIR] [--keep N] [--json]');
      return ok(JSON.stringify({ path: '/backups/tagave-manual-20261011.pgdump', tocEntries: 412 }));
    }
    if (args[0] === 'run' && args.includes('cat')) {
      return args.at(-1) === `${IMAGE_DEPLOY_DIR}/compose.yml` ? ok(this.newCompose) : bad('No such file');
    }
    if (args[0] === 'compose' && args[1] === 'stop') {
      for (const s of args.slice(2)) {
        if (s === 'app' && this.appUp && this.commitsOnStop.has(this.appVersion)) {
          this.backupRows ??= [];
          const id = this.backupRows.reduce((m, r) => Math.max(m, r.id), 0) + 1;
          const path = `/backups/tagave-2026-10-11T10-0${id}-00Z-pre-migration.pgdump`;
          this.backupRows.push({ id, status: 'ok', path, to: this.appVersion });
          this.dumps.add(path);
          this.migrations += 1;
        }
        if (s === 'app') this.appUp = false;
        if (s.startsWith('worker-')) for (const k of [...this.workers.keys()]) if (k.startsWith(`w-${s.slice(7)}`)) this.workers.delete(k);
      }
      return ok();
    }
    if (args[0] === 'compose' && args[1] === 'up') {
      if (args.join(' ') === 'compose up -d app') appStartEnvs.push(opts?.env ?? null);
      const v = await this.envVersion();
      const services = args.slice(3);
      if (services.includes('app') && (!this.appUp || this.appVersion !== v)) {
        this.appVersion = v;
        this.appUp = true;
        if (this.migratesOn.has(v)) {
          this.migrations += 1;
          if (!this.migratesUnrecorded.has(v)) {
            // The new app records its pre-migration dump before it migrates.
            this.backupRows ??= [];
            const id = this.backupRows.reduce((m, r) => Math.max(m, r.id), 0) + 1;
            const path = this.skipPremigrate ? null : `/backups/tagave-2026-10-11T10-0${id}-00Z-pre-migration.pgdump`;
            this.backupRows.push({ id, status: this.skipPremigrate ? 'skipped' : 'ok', path, to: v });
            if (path) this.dumps.add(path);
          }
        }
      }
      if (services.includes('player')) {
        const m = /navidrome:(\S+)/.exec(await readFile(join(this.dir, 'compose.yml'), 'utf8'));
        this.playerImage = `deluan/navidrome:${m?.[1] ?? 'none'}`;
      }
      if (services.some((s) => s.startsWith('worker-')) && !this.brokenWorkers.has(v)) {
        for (const s of services.filter((x) => x.startsWith('worker-'))) {
          for (const k of [...this.workers.keys()]) if (k.startsWith(`w-${s.slice(7)}`)) this.workers.delete(k);
          this.workers.set(`w-${s.slice(7)}-${v}`, { version: v, seenAt: this.now + 1 });
        }
      }
      return ok();
    }
    if (a.includes('tagave-doctor') || a.includes('cli.js restore')) {
      if (this.failRestore) return bad('pg_restore: error: could not connect');
      this.restored = true;
      this.restoredFrom = args[args.indexOf('restore') + 1] ?? null;
      this.migrations = 38;
      return ok('{"database":"tagave"}');
    }
    if (a.startsWith('compose run -d --rm --no-deps --label tagave.updater.handover=')) {
      await this.onReplaceSelf?.();
      return this.replaceSelfResult;
    }
    if (args[0] === 'compose' && args[1] === 'run') return ok('abc123');
    if (a.startsWith('image ls')) {
      if (this.imageLsFails) return bad('Cannot connect to the Docker daemon');
      return ok(this.images.map((r) => `${r.slice(0, r.lastIndexOf(':'))}\t${r.slice(r.lastIndexOf(':') + 1)}\tsha256:${r}`).join('\n'));
    }
    if (a.startsWith('ps -a')) return ok('');
    if (a.startsWith('image inspect')) return ok(`${1024 ** 3}\n`);
    if (args[0] === 'image' && args[1] === 'rm') {
      this.images = this.images.filter((r) => r !== args[2]);
      return ok(`Untagged: ${args[2]}`);
    }
    return bad(`unexpected: docker ${a}`);
  };

  statfs = async () => {
    const free = this.dockerFree[Math.min(this.statfsCalls, this.dockerFree.length - 1)]!;
    this.statfsCalls += 1;
    return { bsize: 4096, bavail: free / 4096, blocks: (100 * GB) / 4096 };
  };

  /** Every tagave image: a shared base layer and one of its own, 200 MB. */
  layers = async (ref: string): Promise<Layer[]> => {
    if (ref.startsWith('postgres')) return [{ digest: 'sha256:pg', size: 150 * MB }];
    return [{ digest: 'sha256:base', size: 100 * MB }, { digest: `sha256:${ref}`, size: 200 * MB }];
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
/** The extra environment of each `compose up -d app`. */
let appStartEnvs: Array<Record<string, string> | null> = [];
let saved: UpdateRun[];
let lastUpdate: Update;

async function update(target: string, overrides: Partial<typeof DEFAULT_CONFIG> = {}, seams: { layers?: (ref: string) => Promise<Layer[]>; selfReplace?: UpdateDeps['selfReplace']; release?: UpdateDeps['release']; docker?: Runner; statfs?: UpdateDeps['statfs'] } = {}) {
  let clock = fake.now;
  const u = new Update(
    {
      installDir: dir,
      docker: seams.docker ?? fake.runner,
      app: fake.app,
      config: { ...DEFAULT_CONFIG, pollMs: 1000, healthTimeoutMs: 30_000, selfUpdate: true, ...overrides },
      save: async (r) => { saved.push(r); },
      now: () => new Date(clock),
      sleep: async (ms) => { clock += ms; },
      statfs: seams.statfs ?? fake.statfs,
      layers: seams.layers ?? fake.layers,
      ...(seams.selfReplace ? { selfReplace: seams.selfReplace } : {}),
      ...(seams.release ? { release: seams.release } : {}),
    },
    newRun('run-1', '0.7.0', target, new Date(clock)),
  );
  lastUpdate = u;
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
  appStartEnvs = [];
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
    // no migrations to apply: the new app took no dump, and the updater none of its own
    expect(run.backup).toBeNull();
    expect(fake.calls.some((c) => c.includes('backup') && c.includes('packages/doctor/dist/cli.js'))).toBe(false);
    expect(fake.appVersion).toBe('0.8.0');
    expect([...fake.workers.values()].map((w) => w.version)).toEqual(['0.8.0', '0.8.0']);
    // the target images were pulled with the version overridden before .env changed
    const firstPull = fake.calls.findIndex((c) => c[1] === 'pull');
    const config = fake.calls.findIndex((c) => c[0] === 'run' && c.includes('cat'));
    expect(firstPull).toBeLessThan(config);
    // the updater is never restarted by the update itself, only replaced at the end by a one-off
    const ups = fake.calls.filter((c) => c[1] === 'up');
    expect(ups.every((c) => !c.includes('updater'))).toBe(true);
    expect(fake.calls.filter((c) => c[1] === 'run' && c.includes('-d'))).toHaveLength(1);
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

  describe('free space', () => {
    // 0.8.0 brings three new tagave images: 3 × 200 MB of their own layers
    // (the base layer is here already) unpack to 1500 MB; one 700 MB dump,
    // the new app's; (1500 + 700) MB × 1.2 + 3 GB headroom = 5712 MB.
    const NEEDED = Math.ceil(2200 * MB * 1.2) + 3 * GB;

    it('refuses just below the requirement, says where and what to delete, and changes nothing', async () => {
      fake.dockerFree = [NEEDED - 10 * MB];
      const run = await update('0.8.0');
      expect(run.status).toBe('failed');
      expect(run.reason).toMatch(/^not enough free disk space: Docker's data on \/var\/lib\/docker has 5\.6 GB free and the update needs 5\.6 GB\. Free at least 10 MB;/);
      expect(run.reason).toContain('docker builder prune');
      expect(run.reason).toContain('old backups');
      expect(run.reason).toMatch(/Nothing was changed\.$/);
      expect(fake.calls.some((c) => c[1] === 'pull')).toBe(false);
      expect(run.log.some((l) => l.message.includes('3 images to download, about 600 MB compressed'))).toBe(true);
    });

    it('goes ahead just above it', async () => {
      fake.dockerFree = [NEEDED + 10 * MB];
      const run = await update('0.8.0');
      expect(run.status).toBe('succeeded');
    });

    it('measures again before the backup, after the images came down', async () => {
      // Plenty at first; the pull eats it.
      fake.dockerFree = [50 * GB, 3.5 * GB];
      const run = await update('0.8.0');
      expect(run.status).toBe('failed');
      expect(stepStatus(run)).toMatchObject({ preflight: 'done', backup: 'failed', config: 'skipped' });
      expect(run.reason).toMatch(/has 3\.5 GB free and the update needs 3\.8 GB.*measured again after the new images were downloaded.*Nothing was changed/);
      expect(fake.calls.some((c) => c.includes('backup'))).toBe(false);
    });

    it("counts what a heavy migration of the new version writes, read from its app image after the download", async () => {
      fake.imageMigrations!.push('0046_cover_thumbs.sql');
      fake.thumbBytes = 1 * GB;
      // room for the images and the dump, not for 3 × 1 GB more
      fake.dockerFree = [50 * GB, 6 * GB];
      const run = await update('0.8.0');
      expect(run.status).toBe('failed');
      expect(stepStatus(run)).toMatchObject({ preflight: 'done', backup: 'failed', config: 'skipped' });
      // (700 MB + 3 GB) × 1.2 + 3 GB
      expect(run.reason).toMatch(/has 6\.0 GB free and the update needs 7\.4 GB.*measured again after the new images were downloaded/);
      expect(run.log.some((l) => l.message.includes('moving the cover thumbnails into their own table (0046_cover_thumbs.sql, 1.0 GB × 3)'))).toBe(true);
      // read from the image preflight pulled, never a fresh download
      expect(fake.calls.find((c) => c.includes('ls'))).toEqual(['run', '--rm', '--pull', 'never', '--network', 'none', '--entrypoint', 'ls', 'ghcr.io/xooxoxxo/tagave-app:0.8.0', '/app/packages/db/migrations']);
    });

    it('does not count a heavy migration the database has applied, nor one it cannot see', async () => {
      fake.imageMigrations!.push('0046_cover_thumbs.sql');
      fake.appliedMigrations.push('0046_cover_thumbs.sql');
      fake.thumbBytes = 10 * GB;
      fake.dockerFree = [50 * GB, 6 * GB];
      expect((await update('0.8.0')).status).toBe('succeeded');
      fake.imageMigrations = null;
      fake.appliedMigrations = [];
      fake.appVersion = '0.7.0';
      await writeFile(join(dir, '.env'), ENV);
      const run = await update('0.8.0');
      expect(run.status).toBe('succeeded');
      expect(run.log.some((l) => l.message.startsWith('space: could not compare the migrations of the new version'))).toBe(true);
    });

    it('checks a separate backups disk on its own', async () => {
      await writeFile(join(dir, '.env'), `${ENV}TAGAVE_BACKUP_DIR=/mnt/nas/tagave-backups\n`);
      fake.backupsDisk = { free: 1 * GB, total: 2000 * GB };
      const run = await update('0.8.0');
      expect(run.status).toBe('failed');
      // 700 MB × 1.2 + 512 MB
      expect(run.reason).toMatch(/the backups on \/backups in the app container has 1\.0 GB free and the update needs 1\.3 GB/);
      expect(run.reason).not.toMatch(/Docker's data on/);
    });

    it('falls back to conservative sizes, and says so, when nothing can be measured', async () => {
      fake.newestBackup = null;
      const run = await update('0.8.0', {}, { layers: async () => { throw new Error('offline'); } });
      expect(run.status).toBe('succeeded');
      const warns = run.log.filter((l) => l.level === 'warn').map((l) => l.message);
      expect(warns.some((m) => /neither a backup nor the database could be measured; counting 2\.0 GB/.test(m))).toBe(true);
      expect(warns.some((m) => /could not read the size of ghcr\.io\/xooxoxxo\/tagave-app:0\.8\.0.*offline.*counting 1\.0 GB/.test(m))).toBe(true);
    });
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
    // the dump the new app took right before it migrated, read back before anything was put back
    const appDump = '/backups/tagave-2026-10-11T10-01-00Z-pre-migration.pgdump';
    expect(restore).toEqual(['compose', 'run', '--rm', '--no-deps', '-T', 'app', 'node', 'packages/doctor/dist/cli.js', 'restore', appDump, '--yes', '--json']);
    expect(run.backup).toBe(appDump);
    expect(fake.calls.some((c) => c.includes('backup') && c.includes('packages/doctor/dist/cli.js'))).toBe(false);
    const verified = fake.calls.findIndex((c) => c.includes('pg_restore') && c.at(-1) === appDump);
    expect(verified).toBeGreaterThan(-1);
    expect(verified).toBeLessThan(fake.calls.indexOf(restore));
    expect(run.log.some((l) => l.message === `the new app backed the database up before it changed it: ${appDump}`)).toBe(true);
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
    expect(run.reason).toMatch(/tagave-doctor restore failed/);
    expect(run.log.at(-1)!.message).toMatch(/do not start 0\.7\.0 on it\. By hand.*restore \/backups\/tagave-2026-10-11T10-01-00Z-pre-migration\.pgdump/);
    expect(await envNow()).toBe('0.7.0');
    // the old version was never started on the changed database
    expect(fake.appUp).toBe(false);
  });

  describe('progress and stalls', () => {
    const states = (n: number, over: object = {}) => Array.from({ length: n }, () => ({ Status: 'running', Restarting: false, OOMKilled: false, ExitCode: 0, Error: '', ...over }));
    const stallOf = () => saved.map((r) => r.stall).find((x) => x);

    it('says what the new app does while it comes up, and clears the sub-state at the end', async () => {
      fake.containers.set('app', { states: states(1), restarts: [0], logs: 'backing up the database to /backups before applying 1 migration(s)...\napplying 0046_cover_thumbs.sql...', calls: 0 });
      const inner = fake.app.health;
      let polls = 0;
      fake.app.health = async () => (fake.appVersion === '0.8.0' && polls++ < 3 ? { ok: false, detail: 'the app does not answer' } : inner());
      const run = await update('0.8.0');
      expect(run.status).toBe('succeeded');
      expect(saved.some((r) => r.progress?.step === 'restart' && r.progress.message === 'waiting for the app: updating the database (0046_cover_thumbs.sql)')).toBe(true);
      expect(saved.some((r) => r.progress?.step === 'verify')).toBe(true);
      expect(run.progress).toBeNull();
      expect(run.stall).toBeNull();
    });

    it('counts the workers on the new version', async () => {
      const inner = fake.app.versions;
      let polls = 0;
      fake.app.versions = async () => {
        const v = await inner();
        if (v && fake.appVersion === '0.8.0' && fake.workers.size === 2 && polls++ < 2) return { ...v, workers: v.workers.slice(0, 1) };
        return v;
      };
      const run = await update('0.8.0');
      expect(run.status).toBe('succeeded');
      expect(saved.some((r) => r.progress?.message === 'workers: 1 of 2 on the new version')).toBe(true);
    });

    it('shows a crash loop within the stall time, with what to do, and rolls back at the timeout', async () => {
      fake.unhealthy.add('0.8.0');
      fake.containers.set('app', {
        states: states(1, { Status: 'restarting', Restarting: true, ExitCode: 1 }),
        restarts: Array.from({ length: 400 }, (_, i) => i),
        logs: 'Error: Cannot find module /app/packages/api/dist/index.js',
        calls: 0,
      });
      const run = await update('0.8.0', { healthTimeoutMs: 5 * 60_000 });
      expect(run.status).toBe('rolled_back');
      const stall = stallOf()!;
      expect(stall.cause).toBe('crash_loop');
      expect(stall.message).toMatch(/^app keeps stopping \(restarted \d+ times?, last exit code 1\): Error: Cannot find module/);
      expect(stall.advice).toMatch(/docker compose logs app/);
      // found once the step had not moved for 2 minutes, not later
      const at = saved.find((r) => r.stall)!;
      const found = Date.parse(at.log.find((l) => l.message.startsWith('no progress for'))!.at);
      expect(found - Date.parse(stall.since)).toBeLessThanOrEqual(2 * 60_000 + 1000);
      expect(run.log.some((l) => l.level === 'warn' && /no progress for \d+ min .*app keeps stopping/.test(l.message))).toBe(true);
    });

    it('shows a full disk', async () => {
      fake.unhealthy.add('0.8.0');
      fake.containers.set('app', { states: states(1), restarts: [0], logs: 'waiting for the database', calls: 0 });
      fake.containers.set('postgres', { states: states(1), restarts: [0], logs: 'PANIC:  could not write to file "pg_wal/xlogtemp.31": No space left on device', calls: 0 });
      const run = await update('0.8.0', { healthTimeoutMs: 3 * 60_000 });
      expect(saved.some((r) => r.progress?.message === 'waiting for the app: no space left on device')).toBe(true);
      expect(stallOf()).toMatchObject({ cause: 'disk_full', service: 'postgres', message: 'postgres has no space left on its disk' });
      expect(run.status).toBe('rolled_back');
    });

    it('asks for patience while Postgres recovers', async () => {
      fake.unhealthy.add('0.8.0');
      fake.containers.set('postgres', { states: states(1), restarts: [0], logs: 'LOG:  database system was interrupted; last known up at 2026-10-16 09:58:01 UTC\nLOG:  redo starts at 0/2D4F1A8', calls: 0 });
      const run = await update('0.8.0', { healthTimeoutMs: 3 * 60_000 });
      expect(saved.some((r) => r.progress?.message === 'waiting for the app: database recovering')).toBe(true);
      expect(stallOf()).toMatchObject({ cause: 'db_recovering' });
      expect(run.log.some((l) => l.level === 'info' && l.message.includes('Postgres is recovering'))).toBe(true);
    });

    it('keeps secrets from container logs out of the run', async () => {
      fake.unhealthy.add('0.8.0');
      fake.containers.set('app', {
        states: states(1, { Status: 'restarting', Restarting: true, ExitCode: 1 }),
        restarts: Array.from({ length: 400 }, (_, i) => i),
        logs: 'Error: password authentication failed for postgres://tagave:Sup3rS3cret@postgres:5432/tagave (APP_SECRET=deadbeef)',
        calls: 0,
      });
      const run = await update('0.8.0', { healthTimeoutMs: 3 * 60_000 });
      expect(stallOf()!.message).toContain('postgres://tagave:***@postgres:5432/tagave (APP_SECRET=***)');
      const everything = JSON.stringify(saved);
      expect(everything).not.toContain('Sup3rS3cret');
      expect(everything).not.toContain('deadbeef');
      expect(run.log.some((l) => l.message.includes('tagave:***@postgres'))).toBe(true);
    });

    it('takes the stall time from the config', async () => {
      fake.unhealthy.add('0.8.0');
      const run = await update('0.8.0', { healthTimeoutMs: 3 * 60_000, stallMs: 10 * 60_000 });
      expect(run.status).toBe('rolled_back');
      expect(stallOf()).toBeUndefined();
    });

    it('checks a download that does not move, and counts a filling disk as moving', async () => {
      let free = 50 * GB;
      const slowPull: Runner = async (args, opts) => {
        if (args[0] === 'compose' && args[1] === 'pull' && opts?.env) {
          await new Promise((r) => setTimeout(r, 120));
          return fake.runner(args, opts);
        }
        return fake.runner(args, opts);
      };
      // stall time 0: the first check finds the download stuck
      const stuck = await update('0.8.0', { stallMs: 0, stallCheckMs: 20 }, { docker: slowPull, statfs: async () => ({ bsize: 4096, bavail: free / 4096, blocks: (100 * GB) / 4096 }) });
      expect(stuck.status).toBe('succeeded');
      expect(stuck.log.some((l) => /no progress for \d+ min .*downloading the images \(0 of 5 done\).*the download has not moved/.test(l.message))).toBe(true);
      saved = [];
      fake.appVersion = '0.7.0';
      await writeFile(join(dir, '.env'), ENV);
      const filling = await update('0.8.0', { stallMs: 0, stallCheckMs: 20 }, { docker: slowPull, statfs: async () => { free -= 50 * MB; return { bsize: 4096, bavail: free / 4096, blocks: (100 * GB) / 4096 }; } });
      expect(filling.log.some((l) => /the download has not moved/.test(l.message))).toBe(false);
    });
  });

  describe('one database dump per update', () => {
    const appDump = '/backups/tagave-2026-10-11T10-01-00Z-pre-migration.pgdump';
    const ownBackups = () => fake.calls.filter((c) => c.includes('packages/doctor/dist/cli.js') && c.includes('backup'));

    it('notes the dump the new app took when it migrated, and takes none itself', async () => {
      fake.migratesOn.add('0.8.0');
      const run = await update('0.8.0');
      expect(run.status).toBe('succeeded');
      expect(run.backup).toBe(appDump);
      expect(ownBackups()).toEqual([]);
      expect(run.log.some((l) => /space: Docker's data .*a database backup ~700 MB/.test(l.message))).toBe(true);
    });

    it('takes its own, filed as before-update, when TAGAVE_SKIP_PREMIGRATE_BACKUP is set, and restores that one', async () => {
      await writeFile(join(dir, '.env'), `${ENV}TAGAVE_SKIP_PREMIGRATE_BACKUP=1\n`);
      fake.skipPremigrate = true;
      fake.migratesOn.add('0.8.0');
      fake.brokenWorkers.add('0.8.0');
      const run = await update('0.8.0');
      expect(ownBackups()).toEqual([['compose', 'exec', '-T', 'app', 'node', 'packages/doctor/dist/cli.js', 'backup', '--kind', 'before-update', '--json']]);
      expect(run.status).toBe('rolled_back');
      expect(fake.restoredFrom).toBe('/backups/tagave-manual-20261011.pgdump');
      expect(run.log.some((l) => l.message.includes("the updater's /backups/tagave-manual-20261011.pgdump is the backup from before it"))).toBe(true);
      // the app takes none, so still one dump in the space check
      expect(run.log.some((l) => /space: Docker's data .*a database backup ~700 MB/.test(l.message))).toBe(true);
    });

    it('takes its own when the app would reuse the dump of an earlier attempt at the same version', async () => {
      fake.backupRows = [{ id: 7, status: 'ok', path: '/backups/tagave-2026-09-01T10-00-00Z-pre-migration.pgdump', to: '0.8.0' }];
      const run = await update('0.8.0');
      expect(run.status).toBe('succeeded');
      expect(ownBackups()).toHaveLength(1);
      expect(run.log.some((l) => l.message.includes('an earlier attempt at 0.8.0 left a backup the new app would reuse'))).toBe(true);
      // the new app is told to take none this once: one dump in the space check, one written
      expect(run.log.some((l) => /space: Docker's data .*a database backup ~700 MB/.test(l.message))).toBe(true);
      expect(fake.calls.find((c) => c.join(' ') === 'compose up -d app')).toBeDefined();
      expect(appStartEnvs[0]).toEqual({ TAGAVE_SKIP_PREMIGRATE_BACKUP: '1' });
    });

    it('takes its own when the record of the app backups cannot be read', async () => {
      fake.psqlFails = true;
      const run = await update('0.8.0');
      expect(run.status).toBe('succeeded');
      expect(ownBackups()).toHaveLength(1);
    });

    it('needs no table yet: the new app creates it and records its dump there', async () => {
      fake.backupRows = null;
      fake.migratesOn.add('0.8.0');
      const run = await update('0.8.0');
      expect(ownBackups()).toEqual([]);
      expect(run.backup).toBe('/backups/tagave-2026-10-11T10-01-00Z-pre-migration.pgdump');
    });

    it('asks an older doctor without --kind', async () => {
      fake.psqlFails = true;
      fake.oldDoctor = true;
      const run = await update('0.8.0');
      expect(run.status).toBe('succeeded');
      expect(ownBackups().map((c) => c.includes('--kind'))).toEqual([true, false]);
      expect(run.backup).toBe('/backups/tagave-manual-20261011.pgdump');
    });

    it('restores the first dump of this run, not one a restart wrote after a part-way migration', async () => {
      fake.migratesOn.add('0.8.0');
      fake.brokenWorkers.add('0.8.0');
      const inner = fake.runner;
      fake.runner = async (args, opts) => {
        const res = await inner(args, opts);
        // a second boot of the new app recorded a dump of the half-migrated database
        if (args.join(' ') === 'compose up -d app' && fake.backupRows?.length === 1) {
          fake.backupRows.push({ id: 2, status: 'ok', path: '/backups/late.pgdump', to: '0.8.0' });
          fake.dumps.add('/backups/late.pgdump');
        }
        return res;
      };
      const run = await update('0.8.0');
      expect(run.status).toBe('rolled_back');
      expect(fake.restoredFrom).toBe(appDump);
    });

    it('does not roll back onto a changed database without its dump: the new version stays', async () => {
      // TAGAVE_SKIP_PREMIGRATE_BACKUP reaches the app some other way than .env
      fake.skipPremigrate = true;
      fake.backupRows = [{ id: 3, status: 'ok', path: '/backups/tagave-2026-09-01T10-00-00Z-pre-migration.pgdump', to: '0.7.0' }];
      fake.migratesOn.add('0.8.0');
      fake.brokenWorkers.add('0.8.0');
      const run = await update('0.8.0');
      expect(run.status).toBe('rollback_failed');
      expect(run.reason).toMatch(/Not rolled back: the database may have been changed, and there is no backup from before the update to restore: the new app migrated without a backup \(TAGAVE_SKIP_PREMIGRATE_BACKUP\)\. 0\.7\.0 must not run on a database 0\.8\.0 changed, so 0\.8\.0 stays in place and was started again\. To go back by hand, restore \/backups\/tagave-2026-09-01T10-00-00Z-pre-migration\.pgdump/);
      expect(fake.restored).toBe(false);
      expect(await envNow()).toBe('0.8.0');
      expect(fake.appVersion).toBe('0.8.0');
      expect(run.rollback).toEqual({ version: '0.8.0', restoredDatabase: false, healthy: false });
      expect(run.log.at(-1)!.message).toMatch(/0\.8\.0 stays in place/);
    });

    it('does not roll back onto a changed database when its dump cannot be read', async () => {
      fake.migratesOn.add('0.8.0');
      fake.brokenWorkers.add('0.8.0');
      const inner = fake.runner;
      fake.runner = async (args, opts) => {
        if (args.includes('pg_restore')) fake.dumps.clear();
        return inner(args, opts);
      };
      const run = await update('0.8.0');
      expect(run.status).toBe('rollback_failed');
      expect(run.reason).toMatch(/its backup from before the update cannot be read: \/backups\/tagave-2026-10-11T10-01-00Z-pre-migration\.pgdump \(pg_restore: error: could not open input file/);
      // the one this run recorded is named for a restore by hand
      expect(run.reason).toMatch(/To go back by hand, restore \/backups\/tagave-2026-10-11T10-01-00Z-pre-migration\.pgdump/);
      expect(fake.restored).toBe(false);
      expect(await envNow()).toBe('0.8.0');
    });

    it('stops the new app before it reads the migration count: a file committed late is seen', async () => {
      fake.commitsOnStop.add('0.8.0');
      fake.brokenWorkers.add('0.8.0');
      const run = await update('0.8.0');
      expect(run.status).toBe('rolled_back');
      expect(run.rollback?.restoredDatabase).toBe(true);
      const stop = fake.calls.findIndex((c) => c.join(' ') === 'compose stop app worker-identify worker-files');
      const count = fake.calls.findIndex((c, i) => i > stop && c.join(' ').includes('select count(*) from _migrations'));
      expect(stop).toBeGreaterThan(-1);
      expect(count).toBeGreaterThan(stop);
    });

    it('takes its own dump when the database cannot be read right before the update', async () => {
      const inner = fake.runner;
      let preflightDone = false;
      fake.runner = async (args, opts) => {
        if (args[0] === 'compose' && args[1] === 'pull') preflightDone = true;
        if (preflightDone && args.join(' ').startsWith('compose exec -T postgres') && !fake.calls.some((c) => c.includes('backup') && c.includes('packages/doctor/dist/cli.js'))) {
          fake.calls.push(args);
          return { code: 1, stdout: '', stderr: 'container is restarting' };
        }
        return inner(args, opts);
      };
      fake.migratesOn.add('0.8.0');
      fake.brokenWorkers.add('0.8.0');
      const run = await update('0.8.0');
      expect(run.log.some((l) => l.message.includes('the database could not be read just before the update'))).toBe(true);
      expect(fake.calls.some((c) => c.includes('backup') && c.includes('packages/doctor/dist/cli.js'))).toBe(true);
      expect(run.status).toBe('rolled_back');
      expect(fake.restoredFrom).toBe('/backups/tagave-manual-20261011.pgdump');
    });

    it("tries the updater's own dump when the app's cannot be read", async () => {
      fake.psqlFails = true;
      fake.migratesOn.add('0.8.0');
      fake.brokenWorkers.add('0.8.0');
      const inner = fake.runner;
      let pulled = false;
      fake.runner = async (args, opts) => {
        // the database answers again from the restart on, and the app's dump is gone
        if (args.join(' ') === 'compose up -d app' && !pulled) { pulled = true; fake.psqlFails = false; }
        if (args.includes('pg_restore') && args.at(-1)!.includes('pre-migration')) return { code: 1, stdout: '', stderr: 'pg_restore: error: input file is too short' };
        return inner(args, opts);
      };
      // a row the new app records although the updater took its own (a skip that did not reach it)
      const run = await update('0.8.0');
      expect(run.status).toBe('rolled_back');
      expect(fake.restoredFrom).toBe('/backups/tagave-manual-20261011.pgdump');
    });

    it('takes no record above the one read before as proof nothing migrated', async () => {
      fake.migratesOn.add('0.8.0');
      fake.migratesUnrecorded.add('0.8.0');
      fake.brokenWorkers.add('0.8.0');
      const run = await update('0.8.0');
      expect(run.status).toBe('rolled_back');
      expect(fake.restored).toBe(false);
    });

    it('does not roll back when the database does not answer and nothing says it was not changed', async () => {
      fake.migratesOn.add('0.8.0');
      fake.brokenWorkers.add('0.8.0');
      const inner = fake.runner;
      fake.runner = async (args, opts) => {
        if (args.includes('verify') || fake.calls.some((c) => c[1] === 'up' && c.length > 4)) fake.psqlFails = true;
        return inner(args, opts);
      };
      const run = await update('0.8.0');
      expect(run.status).toBe('rollback_failed');
      expect(run.reason).toMatch(/the database does not answer, so the backup the new app took cannot be looked up/);
      expect(await envNow()).toBe('0.8.0');
    });
  });

  describe('with the player', () => {
    const PLAYER_COMPOSE = (tag: string) => `${COMPOSE}  player:\n    image: deluan/navidrome:${tag}\n`;
    const idx = (pred: (c: string[]) => boolean) => fake.calls.findIndex(pred);
    const isSnapshot = (c: string[]) => c[1] === 'run' && c.includes('player') && c.at(-1)!.includes('cp -a /data/navidrome /data/snapshots/pre-update');
    const isRestore = (c: string[]) => c[1] === 'run' && c.includes('player') && c.at(-1)!.includes('cp -a /data/snapshots/pre-update /data/navidrome');

    beforeEach(async () => {
      fake.withPlayer = true;
      fake.playerImage = 'deluan/navidrome:0.64.0';
      await writeFile(join(dir, 'compose.yml'), PLAYER_COMPOSE('0.64.0'));
    });

    it('pulls and restarts the player with everything else', async () => {
      fake.newCompose = PLAYER_COMPOSE('0.64.0');
      const run = await update('0.8.0');
      expect(run.status).toBe('succeeded');
      const pulls = fake.calls.filter((c) => c[1] === 'pull');
      expect(pulls.length).toBe(2);
      for (const p of pulls) expect(p).toContain('player');
      expect(fake.calls.some((c) => c[1] === 'up' && c.includes('player'))).toBe(true);
    });

    it('leaves the player data alone when its image does not change', async () => {
      fake.newCompose = PLAYER_COMPOSE('0.64.0');
      const run = await update('0.8.0');
      expect(run.status).toBe('succeeded');
      expect(fake.playerSnapshots).toBe(0);
      expect(fake.calls.some((c) => c[1] === 'stop' && c.includes('player'))).toBe(false);
      expect(run.log.some((l) => l.message.includes('player image unchanged (deluan/navidrome:0.64.0)'))).toBe(true);
      expect(run.log.some((l) => l.message === 'the player reports healthy')).toBe(true);
    });

    it('stops the player and copies its data before the new app starts when its image changes', async () => {
      fake.newCompose = PLAYER_COMPOSE('0.64.2');
      const run = await update('0.8.0');
      expect(run.status).toBe('succeeded');
      expect(fake.playerSnapshots).toBe(1);
      expect(fake.playerRestored).toBe(false);
      const stopWorkers = idx((c) => c[1] === 'stop' && c.includes('worker-files'));
      const stopPlayer = idx((c) => c.join(' ') === 'compose stop player');
      const snapshot = idx(isSnapshot);
      const upApp = idx((c) => c[1] === 'up' && c[3] === 'app' && c.length === 4);
      const upAll = idx((c) => c[1] === 'up' && c.includes('player'));
      expect(stopWorkers).toBeLessThan(stopPlayer);
      expect(stopPlayer).toBeLessThan(snapshot);
      expect(snapshot).toBeLessThan(upApp);
      expect(upApp).toBeLessThan(upAll);
      expect(fake.playerImage).toBe('deluan/navidrome:0.64.2');
      expect(run.log.some((l) => l.message.includes('deluan/navidrome:0.64.0 -> deluan/navidrome:0.64.2'))).toBe(true);
    });

    it('puts the player data back when the update rolls back after the new player started', async () => {
      fake.newCompose = PLAYER_COMPOSE('0.64.2');
      fake.migratesOn.add('0.8.0');
      fake.brokenWorkers.add('0.8.0');
      const run = await update('0.8.0');
      expect(run.status).toBe('rolled_back');
      expect(run.rollback).toEqual({ version: '0.7.0', restoredDatabase: true, healthy: true });
      expect(fake.playerRestored).toBe(true);
      const restore = idx(isRestore);
      const stopPlayer = fake.calls.findLastIndex((c, i) => i < restore && c.join(' ') === 'compose stop player');
      const oldUp = fake.calls.findIndex((c, i) => i > restore && c[1] === 'up' && c[3] === 'app');
      expect(stopPlayer).toBeGreaterThan(idx(isSnapshot));
      expect(restore).toBeGreaterThan(-1);
      expect(oldUp).toBeGreaterThan(restore);
      // the old player runs again on the old image
      expect(fake.playerImage).toBe('deluan/navidrome:0.64.0');
      expect(run.log.some((l) => l.message.startsWith("the player's data is back as it was"))).toBe(true);
    });

    it('rolls back the configuration only when the copy fails, before the new app starts', async () => {
      fake.newCompose = PLAYER_COMPOSE('0.64.2');
      fake.failSnapshot = true;
      const run = await update('0.8.0');
      expect(run.status).toBe('rolled_back');
      expect(stepStatus(run)).toMatchObject({ pull: 'done', restart: 'failed', rollback: 'done' });
      expect(run.reason).toMatch(/copying the player's data failed/);
      expect(run.rollback?.restoredDatabase).toBe(false);
      expect(fake.playerRestored).toBe(false);
      expect(fake.calls.some((c) => c[1] === 'up' && c[3] === 'app' && fake.calls.indexOf(c) < idx(isSnapshot))).toBe(false);
      expect(fake.appVersion).toBe('0.7.0');
      expect(await envNow()).toBe('0.7.0');
    });

    it('warns about an unhealthy player after the update, and does not roll back', async () => {
      fake.newCompose = PLAYER_COMPOSE('0.64.2');
      fake.playerHealth = 'unhealthy';
      const run = await update('0.8.0', { playerHealthTimeoutMs: 10_000 });
      expect(run.status).toBe('succeeded');
      expect(stepStatus(run)).toMatchObject({ verify: 'done', rollback: 'skipped' });
      expect(fake.playerRestored).toBe(false);
      const warning = run.log.find((l) => l.level === 'warn' && l.message.startsWith('the player did not report healthy'));
      expect(warning?.message).toMatch(/the player reports unhealthy.*tagave itself is updated/);
      expect(await envNow()).toBe('0.8.0');
    });
  });
});

// An install from before 0.9 (the project's old name, liner) has LINER_*
// settings in .env. Once the compose files the update installs read the new
// names, the update renames them; a roll back puts the original .env back.
describe('an install from before 0.9', () => {
  const LEGACY_ENV = `${ENV}POSTGRES_USER=liner\nPOSTGRES_DB=liner\nLINER_LIBRARY_ID=lib-1\nLINER_PREMIGRATE_BACKUP_KEEP=7\n`;
  const NEW_COMPOSE = `${COMPOSE}# new\nx-worker-env:\n  TAGAVE_LIBRARY_ID: \${TAGAVE_LIBRARY_ID:-\${LINER_LIBRARY_ID:-}}\n`;

  beforeEach(async () => {
    await writeFile(join(dir, '.env'), LEGACY_ENV, { mode: 0o600 });
  });

  it('renames the LINER_* settings, keeps their values and the database names', async () => {
    fake.newCompose = NEW_COMPOSE;
    const run = await update('0.9.0');
    expect(run.status).toBe('succeeded');
    const env = await readFile(join(dir, '.env'), 'utf8');
    expect(env).not.toMatch(/^LINER_/m);
    expect(envGet(env, 'TAGAVE_LIBRARY_ID')).toBe('lib-1');
    expect(envGet(env, 'TAGAVE_PREMIGRATE_BACKUP_KEEP')).toBe('7');
    expect(envGet(env, 'POSTGRES_USER')).toBe('liner');
    expect(envGet(env, 'POSTGRES_DB')).toBe('liner');
    expect(envGet(env, 'APP_SECRET')).toBe('s3cret');
    expect(envGet(env, 'TAGAVE_VERSION')).toBe('0.9.0');
    expect((await stat(join(dir, '.env'))).mode & 0o777).toBe(0o600);
    expect(envGet(await readFile(join(dir, '.env.bak'), 'utf8'), 'LINER_LIBRARY_ID')).toBe('lib-1');
    const note = run.log.find((l) => l.message.startsWith('renamed the pre-0.9 settings'));
    expect(note?.message).toBe('renamed the pre-0.9 settings in .env: LINER_LIBRARY_ID->TAGAVE_LIBRARY_ID, LINER_PREMIGRATE_BACKUP_KEEP->TAGAVE_PREMIGRATE_BACKUP_KEEP');
    expect(run.log.some((l) => l.message.includes('s3cret'))).toBe(false);
  });

  it('puts the original .env back on a roll back', async () => {
    fake.newCompose = NEW_COMPOSE;
    fake.unhealthy.add('0.9.0');
    const run = await update('0.9.0');
    expect(run.status).toBe('rolled_back');
    expect(await readFile(join(dir, '.env'), 'utf8')).toBe(LEGACY_ENV);
  });

  it('leaves .env alone when the new compose files still read the old names', async () => {
    const run = await update('0.8.1');
    expect(run.status).toBe('succeeded');
    const env = await readFile(join(dir, '.env'), 'utf8');
    expect(envGet(env, 'LINER_LIBRARY_ID')).toBe('lib-1');
    expect(envGet(env, 'TAGAVE_LIBRARY_ID')).toBeNull();
  });
});

describe('old images after an update', () => {
  const set = (v: string) => ['app', 'worker', 'updater'].map((n) => `ghcr.io/xooxoxxo/tagave-${n}:${v}`);

  it('removes the images older than the version it came from, and says so in the log', async () => {
    fake.images = [...set('0.6.0'), ...set('0.7.0'), ...set('0.8.0'), 'postgres:16'];
    const run = await update('0.8.0');
    expect(run.status).toBe('succeeded');
    expect(fake.images.sort()).toEqual([...set('0.7.0'), ...set('0.8.0'), 'postgres:16'].sort());
    const line = run.log.find((l) => l.message.startsWith('removed 3 old images'));
    expect(line?.message).toContain("3.0 GB by Docker's count");
    expect(line?.message).toContain('ghcr.io/xooxoxxo/tagave-app:0.6.0');
    // still before the updater replaces itself
    const removed = fake.calls.findIndex((c) => c[0] === 'image' && c[1] === 'rm');
    expect(removed).toBeLessThan(fake.calls.findIndex((c) => c[1] === 'run' && c.includes('-d')));
  });

  it('a cleanup that fails is a warning; the update still succeeds', async () => {
    fake.imageLsFails = true;
    const run = await update('0.8.0');
    expect(run.status).toBe('succeeded');
    expect(run.log.find((l) => l.level === 'warn' && l.message.startsWith('removing old images failed'))?.message).toMatch(/Cannot connect.*the update itself is done/);
  });

  it('removes nothing after a roll back', async () => {
    fake.images = [...set('0.6.0'), ...set('0.7.0')];
    fake.unhealthy.add('0.8.0');
    const run = await update('0.8.0');
    expect(run.status).toBe('rolled_back');
    // (the free-space check only inspects images)
    expect(fake.calls.some((c) => c[0] === 'image' && c[1] !== 'inspect')).toBe(false);
    expect(fake.images).toHaveLength(6);
  });

  describe('while the updater replaces itself', () => {
    /** The updater process: its gate, and state.json as the server writes it (run + marker). */
    function updaterOn(version: string) {
      const state: { text: string | null; writes: number } = { text: null, writes: 0 };
      const logs: string[] = [];
      const gate = new SelfReplaceGate({
        version,
        persist: async () => { state.writes += 1; state.text = serializeState(saved.at(-1) ?? newRun('run-1', '0.7.0', '0.8.0', new Date(fake.now)), gate.current); },
        now: () => new Date(fake.now),
        log: (level, m) => { logs.push(`${level}: ${m}`); },
      });
      return { gate, state, logs };
    }
    const compare = { handoverBackstopMs: 60_000 };

    it('refuses a second run from the hand-over on, until the new updater is up on the target', async () => {
      const old = updaterOn('0.7.0');
      const attempts: Array<string | null> = [];
      fake.onReplaceSelf = async () => { attempts.push(await old.gate.refusal()); };
      const run = await update('0.8.0', compare, { selfReplace: old.gate });
      expect(run.status).toBe('succeeded');
      expect(attempts).toEqual(['the updater is restarting itself on version 0.8.0; try again in a minute']);
      expect(await old.gate.refusal()).toMatch(/restarting itself on version 0\.8\.0/);
      // the one-off carries the label, and this process waits on the container it started
      expect(fake.calls.find((c) => c[1] === 'run' && c.includes('-d'))).toContain('tagave.updater.handover=run-1');
      expect(fake.waitedOn).toEqual(['ho1']);
      const { marker } = parseState(old.state.text!);
      expect(marker).toMatchObject({ expectedVersion: '0.8.0', fromVersion: '0.7.0', runId: 'run-1' });

      // the replacement starts on 0.8.0, finds the marker, and accepts runs again
      const fresh = updaterOn('0.8.0');
      await fresh.gate.adopt(marker);
      expect(await fresh.gate.refusal()).toBeNull();
      expect(fresh.logs).toEqual(['info: the updater restarted on 0.8.0 as planned']);
    });

    it('writes nothing to state.json after the hand-over began', async () => {
      const old = updaterOn('0.7.0');
      let savesAtBegin = -1;
      fake.onReplaceSelf = async () => { savesAtBegin = saved.length; };
      const run = await update('0.8.0', compare, { selfReplace: old.gate });
      await new Promise((r) => setTimeout(r, 10));
      // the run's last write came before the marker; nothing after it
      expect(saved.length).toBe(savesAtBegin);
      expect(saved.at(-1)!.log.at(-1)!.message).toMatch(/handing over to the updater/);
      expect(saved.at(-1)!.finishedAt).not.toBeNull();
      expect(old.state.writes).toBe(1);
      expect(run.status).toBe('succeeded');
    });

    it('skips the hand-over when the target updater image is the one that runs', async () => {
      const old = updaterOn('0.7.0');
      fake.updaterImageIds.set('ghcr.io/xooxoxxo/tagave-updater:0.8.0', 'sha256:old');
      const run = await update('0.8.0', compare, { selfReplace: old.gate });
      expect(run.status).toBe('succeeded');
      expect(old.gate.current).toBeNull();
      expect(fake.calls.some((c) => c[1] === 'run' && c.includes('-d'))).toBe(false);
      expect(run.log.at(-1)!.message).toMatch(/the updater image did not change/);
    });

    it('hands over when the image ID differs, whatever the version strings say', async () => {
      const old = updaterOn('0.8.0');
      fake.runningUpdaterImage = 'sha256:aaa';
      fake.updaterImageIds.set('ghcr.io/xooxoxxo/tagave-updater:0.8.0', 'sha256:bbb');
      await update('0.8.0', compare, { selfReplace: old.gate });
      expect(old.gate.current?.expectedVersion).toBe('0.8.0');
    });

    it('accepts runs again at once when docker never created the one-off', async () => {
      const old = updaterOn('0.7.0');
      fake.replaceSelfResult = { code: 1, stdout: '', stderr: 'Error: no such image' };
      const run = await update('0.8.0', compare, { selfReplace: old.gate });
      expect(run.status).toBe('succeeded');
      expect(await old.gate.refusal()).toBeNull();
      expect(old.logs.some((l) => /^warn: the one-off container that replaces it did not start.*; still on 0\.7\.0$/.test(l))).toBe(true);
      expect(saved.at(-1)!.log.at(-1)!.message).toMatch(/could not replace itself/);
    });

    it('a compose run that times out keeps refusing; the backstop decides', async () => {
      const old = updaterOn('0.7.0');
      fake.replaceSelfResult = { code: 1, stdout: '', stderr: '\ntimed out after 60 s' };
      await update('0.8.0', { handoverBackstopMs: 30 }, { selfReplace: old.gate });
      expect(await old.gate.refusal()).not.toBeNull();
      await lastUpdate.handover;
      expect(await old.gate.refusal()).toBeNull();
      expect(old.logs.at(-1)).toMatch(/^warn: the hand-over did not replace it within 0 s; still on 0\.7\.0$/);
    });

    it('a timed-out compose run whose container exists is waited on', async () => {
      const old = updaterOn('0.7.0');
      fake.replaceSelfResult = { code: 1, stdout: '', stderr: '\ntimed out after 60 s' };
      fake.handoverListed = true;
      let exit!: (r: CommandResult) => void;
      fake.handoverExit = new Promise((r) => { exit = r; });
      await update('0.8.0', compare, { selfReplace: old.gate });
      expect(fake.waitedOn).toEqual(['ho1']);
      expect(await old.gate.refusal()).not.toBeNull();
      exit({ code: 0, stdout: '1\n', stderr: '' });
      await lastUpdate.handover;
      expect(await old.gate.refusal()).toBeNull();
    });

    it('reopens when the one-off exits and this process is still alive, with its last lines in the log', async () => {
      const old = updaterOn('0.7.0');
      fake.handoverExit = Promise.resolve({ code: 0, stdout: '18\n', stderr: '' });
      await update('0.8.0', compare, { selfReplace: old.gate });
      await lastUpdate.handover;
      expect(await old.gate.refusal()).toBeNull();
      expect(old.logs.at(-1)).toBe('warn: hand-over container exited (code 18); still on 0.7.0');
      const last = saved.at(-1)!.log.at(-1)!.message;
      expect(last).toMatch(/hand-over container exited \(code 18\).*Its last lines: Error response from daemon: pull access denied/);
      expect(parseState(old.state.text!).marker).toBeNull();
    });

    it('the backstop reopens when nothing replaced this process in time', async () => {
      const old = updaterOn('0.7.0');
      await update('0.8.0', { handoverBackstopMs: 20 }, { selfReplace: old.gate });
      expect(await old.gate.refusal()).not.toBeNull();
      await lastUpdate.handover;
      expect(await old.gate.refusal()).toBeNull();
    });

    it('sets no marker after a failed run, or with self-update off', async () => {
      const old = updaterOn('0.7.0');
      fake.missingTags.add('0.8.0');
      expect((await update('0.8.0', compare, { selfReplace: old.gate })).status).toBe('failed');
      expect(old.gate.current).toBeNull();
      fake.missingTags.clear();
      expect((await update('0.8.0', { selfUpdate: false }, { selfReplace: old.gate })).status).toBe('succeeded');
      expect(old.gate.current).toBeNull();
    });
  });
});

describe('an update with a signed manifest', () => {
  const key = testKey();
  const verified = () => {
    const { text, signature } = signed(key, testManifest('0.8.0'));
    return { verified: verifyRelease(text, signature, [key.trusted], { version: '0.8.0' }), platform: 'linux/arm64' };
  };
  /** The pretend install, plus pulls by digest and compose reading the pins from .env. */
  const pinning = (o: { pulled?: (wanted: string) => string; composeIgnoresPins?: boolean } = {}) => {
    const calls: string[] = [];
    const docker: Runner = async (args, opts) => {
      const a = args.join(' ');
      calls.push(a);
      if (args[0] === 'pull') return { code: 0, stdout: '', stderr: '' };
      if (args[0] === 'tag') return { code: 0, stdout: '', stderr: '' };
      if (args[0] === 'image' && args[1] === 'inspect' && args.includes('{{json .RepoDigests}}') && args.at(-1)!.includes('@')) {
        const [ref, wanted] = args.at(-1)!.split('@') as [string, string];
        return { code: 0, stdout: JSON.stringify([`${ref.replace(/:[^:/]+$/, '')}@${o.pulled ? o.pulled(wanted) : wanted}`]), stderr: '' };
      }
      if (a === 'compose config --format json') {
        const env = await readFile(join(dir, '.env'), 'utf8');
        const pin = (k: string) => (o.composeIgnoresPins ? '' : `@${envGet(env, k) ?? ''}`);
        const v = envGet(env, 'TAGAVE_VERSION');
        return {
          code: 0,
          stdout: JSON.stringify({ services: {
            postgres: { image: `postgres:16${pin('TAGAVE_DIGEST_POSTGRES')}` },
            app: { image: `ghcr.io/xooxoxxo/tagave-app:${v}${pin('TAGAVE_DIGEST_APP')}` },
            'worker-identify': { image: `ghcr.io/xooxoxxo/tagave-worker:${v}${pin('TAGAVE_DIGEST_WORKER')}` },
            'worker-files': { image: `ghcr.io/xooxoxxo/tagave-worker:${v}${pin('TAGAVE_DIGEST_WORKER')}` },
            updater: { image: `ghcr.io/xooxoxxo/tagave-updater:${v}${pin('TAGAVE_DIGEST_UPDATER')}` },
          } }),
          stderr: '',
        };
      }
      return fake.runner(args, opts);
    };
    return { docker, calls };
  };

  it('pulls every image by digest, pins them in .env and keeps the signed manifest next to the install', async () => {
    const d = pinning();
    const run = await update('0.8.0', {}, { release: verified(), docker: d.docker });
    expect(run.status).toBe('succeeded');
    for (const [name, c] of [['app', 'a2'], ['worker', 'b2'], ['updater', 'c2']] as const) {
      expect(d.calls).toContain(`pull ghcr.io/xooxoxxo/tagave-${name}:0.8.0@${digest(c)}`);
    }
    expect(d.calls).toContain(`pull postgres:16@${digest('d2')}`);
    expect(d.calls.some((c) => c.startsWith('compose pull app'))).toBe(false);
    const env = await readFile(join(dir, '.env'), 'utf8');
    expect(envGet(env, 'TAGAVE_DIGEST_APP')).toBe(digest('a2'));
    expect(envGet(env, 'TAGAVE_DIGEST_PLAYER')).toBe(digest('e2'));
    expect(await readFile(join(dir, 'release-manifest.json'), 'utf8')).toContain('"version": "0.8.0"');
    expect((await readFile(join(dir, '.updater/release-floor'), 'utf8')).trim()).toBe('0.8.0');
    // the compose files come out of the updater image the manifest pins
    expect(d.calls.some((c) => c.startsWith('run --rm --network none --entrypoint cat') && c.includes(`tagave-updater:0.8.0@${digest('c2')}`))).toBe(true);
  });

  it('refuses an image whose pulled digest differs, before anything changes', async () => {
    const d = pinning({ pulled: (w) => (w === digest('b2') ? digest('66') : w) });
    const run = await update('0.8.0', {}, { release: verified(), docker: d.docker });
    expect(run.status).toBe('failed');
    expect(run.reason).not.toMatch(/unexpected/);
    expect(run.reason).toMatch(/the image pulled for ghcr\.io\/xooxoxxo\/tagave-worker:0\.8\.0 is sha256:6{64}, not sha256:(b2)+ as the signed manifest pins/);
    expect(await envNow()).toBe('0.7.0');
    await expect(stat(join(dir, 'release-manifest.json'))).rejects.toThrow();
  });

  it('rolls back when the compose files would run an image without its pin', async () => {
    const d = pinning({ composeIgnoresPins: true });
    const run = await update('0.8.0', {}, { release: verified(), docker: d.docker });
    expect(run.status).toBe('rolled_back');
    expect(run.reason).toMatch(/would run postgres:16, not postgres:16@sha256:(d2)+ as the signed manifest pins/);
    expect(await envNow()).toBe('0.7.0');
    expect(envGet(await readFile(join(dir, '.env'), 'utf8'), 'TAGAVE_DIGEST_APP')).toBeNull();
    await expect(stat(join(dir, 'release-manifest.json'))).rejects.toThrow();
  });

  it('shows the download image by image, in bytes, from the registry sizes and the pull output', async () => {
    const d = pinning();
    const hex = (ref: string) => [...ref].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7).toString(16).padStart(12, '0').slice(0, 12);
    const layers = async (ref: string): Promise<Layer[]> => [
      { digest: `sha256:${'ab'.repeat(6)}${'0'.repeat(52)}`, size: 100 * MB },
      { digest: `sha256:${hex(ref)}${'0'.repeat(52)}`, size: 200 * MB },
    ];
    const docker: Runner = async (args, opts) => {
      if (args[0] === 'pull') {
        const own = hex(args[1]!);
        opts?.onOutput?.(`${args[1]}: Pulling from x\n${'ab'.repeat(6)}: Pulling fs layer\n${own}: Pulling fs layer\n`);
        opts?.onOutput?.(`${'ab'.repeat(6)}: Download complete\n${own}: Download complete\n`);
      }
      return d.docker(args, opts);
    };
    const run = await update('0.8.0', {}, { release: verified(), docker, layers });
    expect(run.status).toBe('succeeded');
    const seen = [...new Set(saved.filter((r) => r.progress?.step === 'preflight').map((r) => r.progress!.message).filter((m) => m.startsWith('downloading')))];
    expect(seen[0]).toMatch(/^downloading image 1 of \d \(0 MB of 300 MB\)$/);
    // sub-state changes are saved at most once a second (the clock stands still here): only the
    // first one and those a log line carries, not every layer event
    const downloadSaves = saved.filter((r) => r.progress?.step === 'preflight' && r.progress.message.startsWith('downloading')).length;
    // 12 changes (4 images: the start and two layer events each); the log's own writes carry some
    expect(downloadSaves).toBeLessThanOrEqual(6);
    // the shared layer counts once: 100 MB + 4 × 200 MB in all
    expect(seen.at(-1)).toBe('downloading image 4 of 4 (900 MB of 900 MB)');
  });

  it('refuses a TAGAVE_PLAYER_IMAGE override', async () => {
    await writeFile(join(dir, '.env'), `${ENV}TAGAVE_PLAYER_IMAGE=deluan/navidrome:latest\n`);
    const run = await update('0.8.0', {}, { release: verified(), docker: pinning().docker });
    expect(run.status).toBe('failed');
    expect(run.reason).toMatch(/TAGAVE_PLAYER_IMAGE/);
  });
});
