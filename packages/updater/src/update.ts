/**
 * One update, as a state machine:
 *
 *   preflight  .env and services readable, the current install healthy,
 *              enough disk, the target images pulled for this machine's
 *              architecture (a pull with TAGAVE_VERSION overridden, so a
 *              missing tag fails here and nothing has changed yet)
 *   backup     count applied migrations; `tagave-doctor backup` in the app
 *              container (pg_dump, read back with pg_restore --list)
 *   config     compose files from the target's updater image (when it has
 *              them), then TAGAVE_VERSION=<target> in .env; each written
 *              atomically, the old one kept as .bak
 *   pull       docker compose pull (quick: preflight pulled already)
 *   restart    stop the workers, `up -d app` (it backs up and migrates as
 *              it starts), wait for it to answer healthy on the target,
 *              then `up -d` for everything else
 *   verify     health ok, the app on the target, and every local worker
 *              sending heartbeats from the target since the restart
 *
 * The optional player (compose service "player", a bundled Navidrome) is
 * pulled and started with everything else. Navidrome migrates its SQLite
 * database forward only, so when the new compose files pin another player
 * image, restart stops the player and copies its data folder inside its
 * volume (/data/snapshots/pre-update) before the new app starts, and a roll
 * back puts that copy back. A player that is not healthy after a successful
 * update is a warning in the log, never a reason to roll tagave back.
 *
 * A failure in preflight or backup ends the run as `failed`: nothing was
 * changed. A failure from config on rolls back: the old .env and compose
 * files go back; if the migration count moved (or cannot be read), the app
 * and workers are stopped and the backup is restored with `tagave-doctor
 * restore` (the swap restore: the changed database is kept under another
 * name); then the old version is started and checked.
 *
 * The updater service itself is never part of these restarts. After a
 * successful run it is replaced last, by a one-off container, so the process
 * running this code is never the one being recreated mid-run.
 */
import { statfs } from 'node:fs/promises';
import { join } from 'node:path';
import type { UpdateLogLine, UpdateRun, UpdateStep, UpdateStepId } from '@tagave/shared/updater';
import { envGet, envSet, migrateLegacyEnv, readText, writeFileAtomic } from './envFile.js';
import type { AppProbe, CommandResult, Runner } from './runner.js';

export const STEP_LABELS: Record<UpdateStepId, string> = {
  preflight: 'Check the install and download the new images',
  backup: 'Back up the database',
  config: 'Switch the configuration to the new version',
  pull: 'Pull the images',
  restart: 'Restart the app, then the workers',
  verify: 'Check every part runs the new version',
  rollback: 'Roll back',
};

const MAIN_STEPS: UpdateStepId[] = ['preflight', 'backup', 'config', 'pull', 'restart', 'verify'];
const COMPOSE_FILES = ['compose.yml', 'compose.db-published.yml'];
/** Where the updater image keeps the compose files of its release. */
export const IMAGE_DEPLOY_DIR = '/opt/tagave/deploy';
const DOCTOR = ['node', 'packages/doctor/dist/cli.js'];
const MAX_LOG_LINES = 400;
const PLAYER = 'player';
/**
 * Run in a one-off player container: copy Navidrome's data folder to
 * /data/snapshots/pre-update (replacing an older copy). Prints "saved", or
 * "none" when the player never started.
 */
export const PLAYER_SNAPSHOT_SH = [
  'set -e',
  'if [ ! -d /data/navidrome ]; then echo none; exit 0; fi',
  'rm -rf /data/snapshots/pre-update',
  'mkdir -p /data/snapshots',
  'cp -a /data/navidrome /data/snapshots/pre-update',
  'echo saved',
].join('\n');
/** Puts the snapshot back; the folder the new Navidrome changed is kept as rolled-back-<date>. */
export const PLAYER_RESTORE_SH = [
  'set -e',
  'test -d /data/snapshots/pre-update',
  'aside=/data/snapshots/rolled-back-$(date +%Y%m%d-%H%M%S)',
  'if [ -d /data/navidrome ]; then mv /data/navidrome "$aside"; fi',
  'cp -a /data/snapshots/pre-update /data/navidrome',
  'echo restored',
].join('\n');

export interface UpdateConfig {
  minFreeBytes: number;
  /** How long the app (and then the workers) may take to answer on the new version. */
  healthTimeoutMs: number;
  pollMs: number;
  /** pull, up, backup, restore */
  commandTimeoutMs: number;
  /** Replace the updater's own container after a successful run. */
  selfUpdate: boolean;
  /** How long the player may take to report healthy after a successful update. */
  playerHealthTimeoutMs: number;
}

export const DEFAULT_CONFIG: UpdateConfig = {
  minFreeBytes: 2 * 1024 ** 3,
  healthTimeoutMs: 10 * 60_000,
  pollMs: 3000,
  commandTimeoutMs: 20 * 60_000,
  selfUpdate: true,
  playerHealthTimeoutMs: 2 * 60_000,
};

export interface UpdateDeps {
  installDir: string;
  docker: Runner;
  app: AppProbe;
  config: UpdateConfig;
  /** Called on every change, so the state survives the updater restarting. */
  save: (run: UpdateRun) => Promise<void>;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  freeBytes?: () => Promise<number>;
}

class StepFailed extends Error {}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function freeBytesAt(path: string): Promise<number> {
  const s = await statfs(path);
  return s.bavail * s.bsize;
}

export function newRun(id: string, from: string, target: string, now: Date): UpdateRun {
  return {
    id,
    from,
    target,
    status: 'running',
    startedAt: now.toISOString(),
    finishedAt: null,
    steps: [...MAIN_STEPS, 'rollback' as const].map((s): UpdateStep => ({
      id: s,
      label: STEP_LABELS[s],
      status: 'pending',
      startedAt: null,
      finishedAt: null,
    })),
    log: [],
    reason: null,
    backup: null,
    rollback: null,
  };
}

function tail(text: string, lines = 6): string {
  return text.trim().split('\n').slice(-lines).join(' | ');
}

export class Update {
  readonly run: UpdateRun;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private envPath: string;
  private originals = new Map<string, string>();
  private services: string[] = [];
  private registry = 'ghcr.io/xooxoxxo';
  private migrationsBefore: number | null = null;
  /** The new app may have started, so it may have migrated the database. */
  private newAppStarted = false;
  private changed = false;
  /** The player's image before and after the config step (null: no player here). */
  private playerImageBefore: string | null = null;
  private playerImageAfter: string | null = null;
  /** Its data was copied to /data/snapshots/pre-update. */
  private playerSnapshot = false;
  /** The player may have started on the new image. */
  private playerStarted = false;
  private saving: Promise<void> = Promise.resolve();

  constructor(private readonly deps: UpdateDeps, run: UpdateRun) {
    this.run = run;
    this.now = deps.now ?? (() => new Date());
    this.sleep = deps.sleep ?? realSleep;
    this.envPath = join(deps.installDir, '.env');
  }

  // -- bookkeeping ---------------------------------------------------------

  private persist(): Promise<void> {
    const snapshot = structuredClone(this.run);
    this.saving = this.saving.then(() => this.deps.save(snapshot)).catch(() => undefined);
    return this.saving;
  }

  private log(level: UpdateLogLine['level'], message: string): void {
    this.run.log.push({ at: this.now().toISOString(), level, message });
    if (this.run.log.length > MAX_LOG_LINES) this.run.log.splice(0, this.run.log.length - MAX_LOG_LINES);
    void this.persist();
  }

  private step(id: UpdateStepId): UpdateStep {
    return this.run.steps.find((s) => s.id === id)!;
  }

  private begin(id: UpdateStepId): void {
    const s = this.step(id);
    s.status = 'running';
    s.startedAt = this.now().toISOString();
    this.log('info', `${s.label}`);
  }

  private end(id: UpdateStepId, status: 'done' | 'failed' | 'skipped'): void {
    const s = this.step(id);
    s.status = status;
    s.finishedAt = this.now().toISOString();
    void this.persist();
  }

  private fail(message: string): never {
    throw new StepFailed(message);
  }

  // -- docker --------------------------------------------------------------

  private async docker(args: string[], opts: { env?: Record<string, string>; timeoutMs?: number; quiet?: boolean } = {}): Promise<CommandResult> {
    if (!opts.quiet) this.log('info', `$ docker ${args.join(' ')}`);
    const res = await this.deps.docker(args, {
      ...(opts.env ? { env: opts.env } : {}),
      timeoutMs: opts.timeoutMs ?? this.deps.config.commandTimeoutMs,
    });
    if (res.code !== 0 && !opts.quiet) this.log('warn', `exit ${res.code}: ${tail(res.stderr || res.stdout)}`);
    return res;
  }

  private compose(args: string[], opts: { env?: Record<string, string>; timeoutMs?: number; quiet?: boolean } = {}) {
    return this.docker(['compose', ...args], opts);
  }

  private workers(): string[] {
    return this.services.filter((s) => s.startsWith('worker-'));
  }

  private hasPlayer(): boolean {
    return this.services.includes(PLAYER);
  }

  /** The image the player runs with the files as they are now; null without a player. */
  private async playerImage(): Promise<string | null> {
    if (!this.hasPlayer()) return null;
    const res = await this.compose(['config', '--images', PLAYER], { quiet: true, timeoutMs: 60_000 });
    const image = res.code === 0 ? res.stdout.split('\n').map((l) => l.trim()).find(Boolean) : undefined;
    return image ?? null;
  }

  private playerImageChanges(): boolean {
    return this.playerImageBefore !== null && this.playerImageAfter !== null && this.playerImageBefore !== this.playerImageAfter;
  }

  /** Stops the player and copies its data; a failure fails the step before the new app starts. */
  private async snapshotPlayer(): Promise<void> {
    this.log('info', `the player moves from ${this.playerImageBefore} to ${this.playerImageAfter}; Navidrome changes its database only forward, so it is copied first`);
    const stop = await this.compose(['stop', PLAYER]);
    if (stop.code !== 0) this.fail('could not stop the player to copy its data');
    const res = await this.compose(['run', '--rm', '--no-deps', '-T', '--entrypoint', 'sh', PLAYER, '-c', PLAYER_SNAPSHOT_SH], { timeoutMs: 10 * 60_000 });
    const said = res.stdout.trim().split('\n').at(-1)?.trim();
    if (res.code !== 0 || (said !== 'saved' && said !== 'none')) {
      this.fail(`copying the player's data failed: ${tail(res.stderr || res.stdout, 3)}`);
    }
    if (said === 'saved') {
      this.playerSnapshot = true;
      this.log('info', "the player's data is copied to /data/snapshots/pre-update in its volume");
    } else {
      this.log('info', 'the player has no data yet; nothing to copy');
    }
  }

  /** null when the player container reports healthy, else what it reports. */
  private async playerHealth(): Promise<string | null> {
    const ps = await this.compose(['ps', '-q', PLAYER], { quiet: true, timeoutMs: 30_000 });
    const id = ps.stdout.trim().split('\n')[0]?.trim();
    if (ps.code !== 0 || !id) return 'the player container is not running';
    const res = await this.docker(['inspect', '--format', '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}', id], {
      quiet: true,
      timeoutMs: 30_000,
    });
    const state = res.stdout.trim();
    if (res.code === 0 && state === 'healthy') return null;
    return `the player reports ${state || 'nothing'}`;
  }

  private async migrationCount(): Promise<number | null> {
    const res = await this.compose(
      ['exec', '-T', 'postgres', 'sh', '-c', 'psql -X -q -tA -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "select count(*) from _migrations"'],
      { quiet: true, timeoutMs: 30_000 },
    );
    const n = Number(res.stdout.trim());
    return res.code === 0 && res.stdout.trim() !== '' && Number.isInteger(n) ? n : null;
  }

  /** Polls until `check` returns null (good) or the time runs out; returns the last complaint. */
  private async waitFor(check: () => Promise<string | null>, timeoutMs: number): Promise<string | null> {
    const deadline = this.now().getTime() + timeoutMs;
    let last: string | null = 'not checked';
    let lastLogged = '';
    for (;;) {
      last = await check();
      if (last === null) return null;
      if (last !== lastLogged) {
        this.log('info', `waiting: ${last}`);
        lastLogged = last;
      }
      if (this.now().getTime() >= deadline) return last;
      await this.sleep(this.deps.config.pollMs);
    }
  }

  private appOn(version: string | null, since: Date | null, requireWorkers: boolean): () => Promise<string | null> {
    return async () => {
      const h = await this.deps.app.health();
      if (!h.ok) return h.detail;
      const v = await this.deps.app.versions();
      if (!v) return 'the app does not report its version yet';
      if (version && v.app !== version) return `the app reports ${v.app ?? 'no version'}, not ${version}`;
      if (!requireWorkers) return null;
      const want = this.workers().length;
      const fresh = v.workers.filter((w) => w.version === version && (!since || Date.parse(w.lastSeenAt) >= since.getTime() - 1000));
      if (fresh.length < want) {
        const others = v.workers.filter((w) => w.version !== version).map((w) => w.version ?? '?');
        return `${fresh.length} of ${want} workers report ${version}${others.length ? ` (others: ${others.join(', ')})` : ''}`;
      }
      return null;
    };
  }

  // -- the steps -------------------------------------------------------------

  private async preflight(): Promise<void> {
    const env = await readText(this.envPath);
    if (env === null) this.fail(`there is no .env in ${this.deps.installDir}`);
    this.originals.set('.env', env);
    const role = envGet(env, 'TAGAVE_ROLE');
    if (role === 'files') this.fail('this computer runs only the file worker; update the app computer instead');
    this.registry = envGet(env, 'TAGAVE_REGISTRY') || this.registry;
    if (this.run.target === this.run.from) this.fail(`${this.run.target} already runs here`);

    const svc = await this.compose(['config', '--services'], { quiet: true, timeoutMs: 60_000 });
    if (svc.code !== 0) this.fail(`docker compose cannot read the configuration: ${tail(svc.stderr)}`);
    this.services = svc.stdout.split('\n').map((s) => s.trim()).filter((s) => s && s !== 'updater');
    if (!this.services.includes('app')) this.fail('the app does not run on this computer');
    this.log('info', `services: ${this.services.join(', ')}`);

    const health = await this.deps.app.health();
    if (!health.ok) this.fail(`the install is not healthy now, so an update would be hard to judge: ${health.detail}`);

    const free = await (this.deps.freeBytes ?? (() => freeBytesAt('/')))();
    const gb = (n: number) => `${(n / 1024 ** 3).toFixed(1)} GB`;
    if (free < this.deps.config.minFreeBytes) {
      this.fail(`only ${gb(free)} free for Docker; the update needs ${gb(this.deps.config.minFreeBytes)} for the new images and the backup`);
    }
    this.log('info', `${gb(free)} free`);

    const pull = await this.compose(['pull', ...this.services, ...(this.hasUpdaterService(svc.stdout) ? ['updater'] : [])], {
      env: { TAGAVE_VERSION: this.run.target },
    });
    if (pull.code !== 0) {
      const text = `${pull.stderr}\n${pull.stdout}`;
      if (/no matching manifest|platform/i.test(text)) this.fail(`${this.run.target} has no image for this computer's architecture`);
      if (/not found|manifest unknown|does not exist/i.test(text)) this.fail(`${this.run.target} is not published (${this.registry})`);
      this.fail(`downloading the ${this.run.target} images failed: ${tail(text, 3)}`);
    }
  }

  private hasUpdaterService(servicesOut: string): boolean {
    return servicesOut.split('\n').some((s) => s.trim() === 'updater');
  }

  private async backup(): Promise<void> {
    this.migrationsBefore = await this.migrationCount();
    this.log('info', `migrations applied: ${this.migrationsBefore ?? 'unknown'}`);
    const res = await this.compose(['exec', '-T', 'app', ...DOCTOR, 'backup', '--json']);
    if (res.code !== 0) this.fail(`the backup failed: ${tail(res.stderr || res.stdout, 3)}`);
    let path: string | undefined;
    try {
      const json = JSON.parse(res.stdout.slice(res.stdout.indexOf('{'))) as { path?: string; tocEntries?: number };
      path = json.path;
      this.log('info', `backup ${json.path} (verified, ${json.tocEntries ?? '?'} entries)`);
    } catch {
      /* handled below */
    }
    if (!path) this.fail('the backup did not say where it wrote the dump');
    this.run.backup = path;
  }

  private async config(): Promise<void> {
    this.playerImageBefore = await this.playerImage();
    for (const name of COMPOSE_FILES) {
      const text = await readText(join(this.deps.installDir, name));
      if (text !== null) this.originals.set(name, text);
    }
    this.changed = true;
    const image = `${this.registry}/tagave-updater:${this.run.target}`;
    for (const name of COMPOSE_FILES) {
      if (!this.originals.has(name)) continue;
      const res = await this.docker(['run', '--rm', '--network', 'none', '--entrypoint', 'cat', image, `${IMAGE_DEPLOY_DIR}/${name}`], {
        quiet: true,
        timeoutMs: 60_000,
      });
      if (res.code === 0 && res.stdout.includes('services:')) {
        if (res.stdout !== this.originals.get(name)) {
          await writeFileAtomic(join(this.deps.installDir, name), res.stdout);
          this.log('info', `${name} replaced with the one from ${this.run.target} (old one kept as ${name}.bak)`);
        }
      } else {
        this.log('warn', `${image} has no ${name}; keeping the current one`);
      }
    }
    let env = this.originals.get('.env')!;
    // Settings named LINER_* before 0.9 get their TAGAVE_* names once the
    // compose files in place read them (the old compose.yml read
    // LINER_LIBRARY_ID). A roll back puts the original .env back.
    const compose = await readText(join(this.deps.installDir, 'compose.yml'));
    if (compose?.includes('TAGAVE_LIBRARY_ID')) {
      const migrated = migrateLegacyEnv(env);
      if (migrated.notes.length > 0) {
        env = migrated.text;
        this.log('info', `renamed the pre-0.9 settings in .env: ${migrated.notes.join(', ')}`);
      }
    }
    await writeFileAtomic(this.envPath, envSet(env, 'TAGAVE_VERSION', this.run.target));
    this.log('info', `TAGAVE_VERSION=${this.run.target} in .env (was ${this.run.from}; old file kept as .env.bak)`);
    const check = await this.compose(['config', '--quiet'], { timeoutMs: 60_000 });
    if (check.code !== 0) this.fail(`docker compose rejects the new configuration: ${tail(check.stderr, 3)}`);
    this.playerImageAfter = await this.playerImage();
    if (this.playerImageBefore !== null) {
      this.log('info', this.playerImageChanges()
        ? `player image: ${this.playerImageBefore} -> ${this.playerImageAfter}`
        : `player image unchanged (${this.playerImageBefore})`);
    }
  }

  private async pull(): Promise<void> {
    const res = await this.compose(['pull', ...this.services]);
    if (res.code !== 0) this.fail(`docker compose pull failed: ${tail(res.stderr, 3)}`);
  }

  private async restart(): Promise<Date> {
    const workers = this.workers();
    if (workers.length) {
      const stop = await this.compose(['stop', ...workers]);
      if (stop.code !== 0) this.fail('could not stop the workers');
    }
    if (this.playerImageChanges()) await this.snapshotPlayer();
    this.newAppStarted = true;
    const startedAt = this.now();
    const up = await this.compose(['up', '-d', 'app']);
    if (up.code !== 0) this.fail(`the new app did not start: ${tail(up.stderr, 3)}`);
    this.log('info', 'waiting for the new app (it backs up and updates the database before it answers)');
    const appIssue = await this.waitFor(this.appOn(this.run.target, null, false), this.deps.config.healthTimeoutMs);
    if (appIssue) this.fail(`the app did not answer healthy on ${this.run.target}: ${appIssue}`);
    if (this.hasPlayer()) this.playerStarted = true;
    const rest = await this.compose(['up', '-d', ...this.services]);
    if (rest.code !== 0) this.fail(`docker compose could not start the workers: ${tail(rest.stderr, 3)}`);
    return startedAt;
  }

  private async verify(since: Date): Promise<void> {
    const issue = await this.waitFor(this.appOn(this.run.target, since, true), this.deps.config.healthTimeoutMs);
    if (issue) this.fail(`not every part reports ${this.run.target}: ${issue}`);
    if (this.hasPlayer()) await this.checkPlayer();
  }

  /** Warns, never fails: tagave runs fine while the player is down. */
  private async checkPlayer(): Promise<void> {
    const issue = await this.waitFor(() => this.playerHealth(), this.deps.config.playerHealthTimeoutMs);
    if (issue === null) {
      this.log('info', 'the player reports healthy');
      return;
    }
    const minutes = Math.round(this.deps.config.playerHealthTimeoutMs / 60_000);
    this.log('warn', `the player did not report healthy within ${minutes} minute${minutes === 1 ? '' : 's'} (${issue}). tagave itself is updated and runs; check the player with docker compose logs player`);
  }

  /** Puts the player's data back as it was before the update. */
  private async restorePlayer(): Promise<void> {
    this.log('warn', "the new player may have changed its database; putting the copy from before the update back");
    const stop = await this.compose(['stop', PLAYER]);
    if (stop.code !== 0) throw new Error('could not stop the player to restore its data');
    const res = await this.compose(['run', '--rm', '--no-deps', '-T', '--entrypoint', 'sh', PLAYER, '-c', PLAYER_RESTORE_SH], { timeoutMs: 10 * 60_000 });
    if (res.code !== 0 || !res.stdout.includes('restored')) {
      throw new Error(`restoring the player's data failed: ${tail(res.stderr || res.stdout, 3)}; the copy is in /data/snapshots/pre-update in the player's volume`);
    }
    this.log('info', "the player's data is back as it was; the changed copy is kept in /data/snapshots/rolled-back-<date>");
  }

  private async rollbackAll(reason: string): Promise<void> {
    this.begin('rollback');
    let restored = false;
    let healthy = false;
    try {
      const after = this.newAppStarted ? await this.migrationCount() : this.migrationsBefore;
      const needsRestore = this.newAppStarted && (after === null || this.migrationsBefore === null || after !== this.migrationsBefore);
      this.log('info', `migrations before ${this.migrationsBefore ?? 'unknown'}, now ${after ?? 'unknown'}`);

      for (const [name, text] of this.originals) {
        await writeFileAtomic(join(this.deps.installDir, name), text, false);
      }
      this.log('info', `put back .env (TAGAVE_VERSION=${envGet(this.originals.get('.env') ?? '', 'TAGAVE_VERSION') ?? this.run.from}) and the compose files`);

      if (needsRestore) {
        if (!this.run.backup) throw new Error('the database changed but there is no backup to restore');
        this.log('warn', 'the new version changed the database; restoring the backup');
        await this.compose(['stop', 'app', ...this.workers()]);
        const res = await this.compose(['run', '--rm', '--no-deps', '-T', 'app', ...DOCTOR, 'restore', this.run.backup, '--yes', '--json']);
        if (res.code !== 0) throw new Error(`tagave-doctor restore failed: ${tail(res.stderr || res.stdout, 3)}`);
        restored = true;
        let kept = 'under another name';
        try {
          const json = JSON.parse(res.stdout.slice(res.stdout.indexOf('{'))) as { previousDatabase?: string | null };
          if (json.previousDatabase) kept = `as ${json.previousDatabase} (drop it once you are happy)`;
        } catch {
          /* keep the generic wording */
        }
        this.log('info', `restored ${this.run.backup}; the changed database is kept ${kept}`);
      }

      if (this.playerSnapshot && this.playerStarted) await this.restorePlayer();

      const up = await this.compose(['up', '-d', 'app']);
      if (up.code !== 0) throw new Error(`the old app did not start: ${tail(up.stderr, 3)}`);
      const from = /^\d+\.\d+\.\d+/.test(this.run.from) ? this.run.from : null;
      const issue = await this.waitFor(this.appOn(from, null, false), this.deps.config.healthTimeoutMs);
      if (issue) throw new Error(`the old version did not answer healthy: ${issue}`);
      const rest = await this.compose(['up', '-d', ...this.services]);
      if (rest.code !== 0) throw new Error(`the workers did not start: ${tail(rest.stderr, 3)}`);
      healthy = true;
      this.end('rollback', 'done');
      this.run.status = 'rolled_back';
      this.run.reason = reason;
      this.log('warn', `rolled back to ${this.run.from}${restored ? ' with the database restored' : ''}`);
    } catch (err) {
      this.end('rollback', 'failed');
      this.run.status = 'rollback_failed';
      this.run.reason = `${reason}. The roll back did not finish: ${(err as Error).message}`;
      this.log('error', `roll back failed: ${(err as Error).message}`);
      this.log('error', `by hand, in the install folder: check TAGAVE_VERSION in .env is ${this.run.from}, then docker compose up -d${
        this.run.backup ? `; if the app refuses the database, restore ${this.run.backup} with tagave-doctor restore (docs/operations.md, Roll back)` : ''}`);
    }
    this.run.rollback = {
      version: envGet(this.originals.get('.env') ?? '', 'TAGAVE_VERSION') ?? this.run.from,
      restoredDatabase: restored,
      healthy,
    };
  }

  private async replaceSelf(): Promise<void> {
    // A one-off container of the updater service, on the new image, recreates
    // the updater service container; this process is the one being replaced,
    // so it must not do that itself.
    const res = await this.compose(['run', '-d', '--rm', '--no-deps', '--entrypoint', 'sh', 'updater', '-c', 'sleep 3; docker compose up -d --no-deps updater'], {
      timeoutMs: 60_000,
    });
    if (res.code === 0) this.log('info', 'the updater restarts on the new version in a few seconds');
    else this.log('warn', 'the updater could not replace itself; it moves to the new version at its next restart (docker compose up -d updater)');
  }

  // -- driver ----------------------------------------------------------------

  async execute(): Promise<UpdateRun> {
    let current: UpdateStepId = 'preflight';
    try {
      this.begin('preflight');
      await this.preflight();
      this.end('preflight', 'done');
      current = 'backup';
      this.begin('backup');
      await this.backup();
      this.end('backup', 'done');
      current = 'config';
      this.begin('config');
      await this.config();
      this.end('config', 'done');
      current = 'pull';
      this.begin('pull');
      await this.pull();
      this.end('pull', 'done');
      current = 'restart';
      this.begin('restart');
      const since = await this.restart();
      this.end('restart', 'done');
      current = 'verify';
      this.begin('verify');
      await this.verify(since);
      this.end('verify', 'done');
      this.end('rollback', 'skipped');
      this.run.status = 'succeeded';
      this.log('info', `tagave ${this.run.target} runs and reports healthy`);
    } catch (err) {
      const reason = err instanceof StepFailed ? err.message : `unexpected error: ${(err as Error).message}`;
      this.end(current, 'failed');
      this.log('error', reason);
      for (const s of this.run.steps) if (s.status === 'pending' && s.id !== 'rollback') s.status = 'skipped';
      if (this.changed) {
        await this.rollbackAll(reason);
      } else {
        this.end('rollback', 'skipped');
        this.run.status = 'failed';
        this.run.reason = `${reason}. Nothing was changed.`;
      }
    }
    this.run.finishedAt = this.now().toISOString();
    await this.persist();
    if (this.run.status === 'succeeded' && this.deps.config.selfUpdate) {
      await this.replaceSelf();
      await this.persist();
    }
    return this.run;
  }
}
