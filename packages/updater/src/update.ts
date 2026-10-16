/**
 * One update, as a state machine:
 *
 *   preflight  .env and services readable, the current install healthy,
 *              room on disk for the images and the backups (see
 *              preflight-space.ts), the target images pulled for this machine's
 *              architecture (a pull with TAGAVE_VERSION overridden, so a
 *              missing tag fails here and nothing has changed yet)
 *   backup     free space measured again; count applied migrations and
 *              note the app's backup record (rollback-dump.ts). The new
 *              app dumps the database itself right before it migrates, so
 *              the updater takes no dump of its own unless the app's
 *              cannot be counted on; then `tagave-doctor backup --kind
 *              before-update` in the app container
 *   config     compose files from the target's updater image (when it has
 *              them), then TAGAVE_VERSION=<target> in .env; each written
 *              atomically, the old one kept as .bak
 *   pull       docker compose pull (quick: preflight pulled already)
 *   restart    stop the workers, `up -d app` (it backs up and migrates as
 *              it starts), wait for it to answer healthy on the target,
 *              then `up -d` for everything else; the dump the app recorded
 *              becomes the run's backup
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
 * and workers are stopped and the dump the new app recorded before it
 * migrated (or the updater's own) is restored with `tagave-doctor restore`
 * (the swap restore: the changed database is kept under another name); then
 * the old version is started and checked. When the database changed and no
 * readable dump from before the update exists, nothing is rolled back: the
 * old version must never run on a database a newer one migrated, so the new
 * version stays in place and the run says what to do by hand.
 *
 * Every step keeps a sub-state in the run (progress.ts): the download in
 * bytes, what the app does while it comes up, how many workers report the
 * target. A step whose sub-state does not move for config.stallMs is
 * diagnosed from the containers' state and last log lines, and the cause
 * and what to do are shown with the run; the step's own timeout still
 * decides when to give up.
 *
 * After a successful run the images older than the version it came from
 * are removed (image-hygiene.ts); a failure there is a warning in the log.
 *
 * The updater service itself is never part of these restarts. After a
 * successful run it is replaced last, by a one-off container, so the process
 * running this code is never the one being recreated mid-run.
 */
import { statfs } from 'node:fs/promises';
import { join } from 'node:path';
import type { UpdateLogLine, UpdateRun, UpdateStep, UpdateStepId } from '@tagave/shared/updater';
import { unlink } from 'node:fs/promises';
import { envGet, envKeys, envSet, envUnset, migrateLegacyEnv, readText, writeFileAtomic } from './envFile.js';
import { MODULES_DIR, isOn, moduleComposeFile, pullVerified, renderModuleCompose, withRegistry } from './modules.js';
import { MANIFEST_FILE, ReleaseRefused, SIGNATURE_FILE, digestFor, envPins, imageForService, type VerifiedRelease } from './release.js';
import {
  DEFAULT_STALL_MS,
  INSPECT_FORMAT,
  PullProgress,
  ComposePullProgress,
  diagnoseStall,
  parseInspect,
  stallNeedsAction,
  waitingFor,
  type Observation,
  type Readings,
} from './progress.js';
import { mkdirKeepingOwner, writeFileKeepingOwner } from './safe-write.js';
import { redact } from './redact.js';
import { formatBytes, playerGroups, removeOldImages, tagaveGroups } from './image-hygiene.js';
import { IMAGE_MIGRATIONS_DIR, pendingHeavy } from './heavy-migrations.js';
import { backupsOnHostFolder, checkSpace, registryClient, type Layer, type StatfsLike } from './preflight-space.js';
import {
  BACKUPS_TABLE_SQL,
  LAST_BACKUP_SQL,
  firstBackupSinceSql,
  ownDumpReason,
  parseLastBackup,
  parseRecordedDump,
  type LastBackup,
} from './rollback-dump.js';
import type { AppProbe, CommandResult, Runner } from './runner.js';
import { HANDOVER_LABEL, type SelfReplaceHooks } from './self-replace.js';

export const STEP_LABELS: Record<UpdateStepId, string> = {
  preflight: 'Check the install and download the new images',
  backup: 'Check the database before its backup',
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
/** Sub-state changes are saved at most this often (persistSoon). */
const PROGRESS_SAVE_MS = 1000;
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
  /** Left free on Docker's filesystem once the images and backups are written. */
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
  /** How long this process may outlive the hand-over to its replacement before it takes it as failed. */
  handoverBackstopMs: number;
  /** A step whose sub-state does not move for this long is diagnosed (TAGAVE_UPDATER_STALL_SECONDS). */
  stallMs: number;
  /** How often the containers are inspected while waiting for them. */
  observeEveryMs: number;
  /** How often a long command (a pull, a dump, a restore) is checked for a stall. */
  stallCheckMs: number;
}

export const DEFAULT_CONFIG: UpdateConfig = {
  minFreeBytes: 3 * 1024 ** 3,
  healthTimeoutMs: 10 * 60_000,
  pollMs: 3000,
  commandTimeoutMs: 20 * 60_000,
  selfUpdate: true,
  playerHealthTimeoutMs: 2 * 60_000,
  handoverBackstopMs: 150_000,
  stallMs: DEFAULT_STALL_MS,
  observeEveryMs: 10_000,
  stallCheckMs: 15_000,
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
  /** Test seams for the free-space check: statfs of the updater's root, and image layers from the registry. */
  statfs?: (path: string) => Promise<StatfsLike>;
  layers?: (ref: string, signal?: AbortSignal) => Promise<Layer[]>;
  /** Told before and (on failure) after the updater hands over to its replacement (self-replace.ts). */
  selfReplace?: SelfReplaceHooks;
  /**
   * The target's signed manifest, verified (release.ts), and this computer's
   * platform: every image is pulled by its digest and checked, and .env pins
   * them. The updater service never starts a run without it.
   */
  release?: { verified: VerifiedRelease; platform: string };
}

/** The newest release this install has run, remembered for downgrade protection (release.ts). */
export const RELEASE_FLOOR_FILE = '.updater/release-floor';

class StepFailed extends Error {}

/** What waitFor watches while it polls: the containers to inspect, and how to word the sub-state. */
interface Watch {
  services: string[];
  /** `detail`: what the check said; `seen`: what the containers say (waitingFor), or null. */
  describe: (detail: string, seen: string | null) => string;
}
/** The roll back stops before it changes anything: the new version stays, matching the database it changed. */
class KeepNewVersion extends Error {}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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

/** repository:tag of a pinned reference (repository:tag@sha256:…): pulled images are tagged so too. */
function withoutDigest(ref: string | null): string | null {
  return ref === null ? null : ref.replace(/@sha256:[0-9a-f]+$/, '');
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
  /** Why the updater takes a dump of its own (rollback-dump.ts); null: the new app's is the rollback point. */
  private ownDump: string | null = null;
  /** The highest _migration_backups id before the new app started (null: unknown); the app's dump of this run is above it. */
  private backupsMaxId: number | null = null;
  /** The dump the updater took itself, when it took one. */
  private ownDumpPath: string | null = null;
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
  /** Files the config step created (they are deleted again on a roll back). */
  private created: string[] = [];
  /** Handed over to the replacement: this process writes nothing more to state.json unless the hand-over fails. */
  private handedOver = false;
  /** Settles when the hand-over watch ends (the replacement kills this process first when it works). For tests. */
  handover: Promise<void> = Promise.resolve();
  /** Restart counts of the containers when the running step first saw them. */
  private restartsAt = new Map<string, number>();
  private lastObserved = 0;
  private lastDiagnosed = 0;
  private diagnosing = false;
  private lastProgressSave = -Infinity;
  private progressTimer: ReturnType<typeof setTimeout> | null = null;
  /** The tail of a running command's output (a pull), for the stall check. */
  private commandOutput = '';
  /** Free bytes on Docker's disk at the last check during a download: docker pull prints nothing while a layer comes down. */
  private downloadFree: number | null = null;

  constructor(private readonly deps: UpdateDeps, run: UpdateRun) {
    this.run = run;
    this.now = deps.now ?? (() => new Date());
    this.sleep = deps.sleep ?? realSleep;
    this.envPath = join(deps.installDir, '.env');
  }

  // -- bookkeeping ---------------------------------------------------------

  private persist(): Promise<void> {
    if (this.progressTimer) {
      clearTimeout(this.progressTimer);
      this.progressTimer = null;
    }
    if (this.handedOver) return this.saving;
    const snapshot = structuredClone(this.run);
    this.saving = this.saving.then(() => this.deps.save(snapshot)).catch(() => undefined);
    return this.saving;
  }

  private log(level: UpdateLogLine['level'], message: string): void {
    this.run.log.push({ at: this.now().toISOString(), level, message: redact(message) });
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
    this.restartsAt.clear();
    this.lastObserved = 0;
    this.run.stall = null;
    this.run.progress = { step: id, message: s.label.toLowerCase(), at: s.startedAt };
    this.log('info', `${s.label}`);
  }

  // -- progress and stalls (progress.ts) -------------------------------------

  /** The running step's sub-state; a change counts as progress and clears a stall. */
  private progress(message: string): void {
    const step = this.run.steps.find((s) => s.status === 'running')?.id ?? this.run.progress?.step ?? 'preflight';
    if (this.run.progress?.message === redact(message) && this.run.progress.step === step) return;
    this.run.progress = { step, message: redact(message), at: this.now().toISOString() };
    if (this.run.stall) {
      this.run.stall = null;
      this.log('info', `moving again: ${message}`);
      return;
    }
    this.persistSoon();
  }

  /**
   * A sub-state change is written at most about once a second (a pull can
   * change it many times a second); the latest one is written when the
   * second is up, and any other write (a log line, the end of the run)
   * carries it too.
   */
  private persistSoon(): void {
    const now = this.now().getTime();
    if (now - this.lastProgressSave >= PROGRESS_SAVE_MS && !this.progressTimer) {
      this.lastProgressSave = now;
      void this.persist();
      return;
    }
    if (this.progressTimer) return;
    this.progressTimer = setTimeout(() => {
      this.progressTimer = null;
      this.lastProgressSave = this.now().getTime();
      void this.persist();
    }, PROGRESS_SAVE_MS);
    this.progressTimer.unref?.();
  }

  /** The services' containers as docker sees them now, with their last log lines. */
  private async observe(services: string[]): Promise<Readings> {
    const observations: Observation[] = [];
    for (const service of services) {
      const ps = await this.compose(['ps', '-a', '-q', service], { quiet: true, timeoutMs: 30_000 });
      const id = ps.code === 0 ? ps.stdout.trim().split('\n')[0]?.trim() : '';
      if (!id) {
        observations.push({ service, state: null, logs: '', restartsBefore: this.restartsAt.get(service) ?? 0 });
        continue;
      }
      const inspect = await this.docker(['inspect', '--format', INSPECT_FORMAT, id], { quiet: true, timeoutMs: 30_000 });
      const state = inspect.code === 0 ? parseInspect(inspect.stdout) : null;
      const logs = await this.docker(['logs', '--tail', '40', id], { quiet: true, timeoutMs: 30_000 });
      if (state && !this.restartsAt.has(service)) this.restartsAt.set(service, state.restarts);
      observations.push({ service, state, logs: logs.code === 0 ? `${logs.stdout}\n${logs.stderr}` : '', restartsBefore: this.restartsAt.get(service) ?? state?.restarts ?? 0 });
    }
    let dockerFreeBytes: number | null = null;
    try {
      const st = await (this.deps.statfs ?? statfs)('/');
      dockerFreeBytes = st.bavail * st.bsize;
    } catch {
      /* unknown */
    }
    this.lastObserved = this.now().getTime();
    return { observations, dockerFreeBytes, commandOutput: this.commandOutput };
  }

  /**
   * When the running step has not moved for config.stallMs: inspect the
   * containers it waits on and put the likely cause on the run. `readings`:
   * taken just now by the caller.
   */
  private async checkStall(services: string[], downloading: boolean, readings?: Readings): Promise<void> {
    const p = this.run.progress;
    if (!p || this.diagnosing || this.run.status !== 'running') return;
    if (downloading && (await this.downloadMoved())) return;
    const nowMs = this.now().getTime();
    const stalledMs = nowMs - Date.parse(p.at);
    if (stalledMs < this.deps.config.stallMs) return;
    if (this.run.stall && nowMs - this.lastDiagnosed < this.deps.config.observeEveryMs) return;
    this.diagnosing = true;
    try {
      const r = readings ?? (await this.observe(services.filter((s) => s === 'postgres' || this.services.includes(s))));
      if (this.run.progress !== p) return;
      const stall = diagnoseStall(r, { progress: p.message, stalledMs, since: p.at, downloading });
      this.lastDiagnosed = nowMs;
      if (this.run.stall?.cause === stall.cause && this.run.stall.message === redact(stall.message)) return;
      this.run.stall = { ...stall, message: redact(stall.message), advice: redact(stall.advice) };
      this.log(stallNeedsAction(stall.cause) ? 'warn' : 'info', `no progress for ${Math.max(1, Math.round(stalledMs / 60_000))} min (${p.message}): ${stall.message}. ${stall.advice}`);
    } finally {
      this.diagnosing = false;
    }
  }

  /**
   * Off a terminal, docker pull says nothing while a layer downloads, so a
   * download counts as moving while Docker's disk fills (by 1 MB or more
   * since the last check).
   */
  private async downloadMoved(): Promise<boolean> {
    let free: number;
    try {
      const st = await (this.deps.statfs ?? statfs)('/');
      free = st.bavail * st.bsize;
    } catch {
      return false;
    }
    const before = this.downloadFree;
    this.downloadFree = free;
    if (before === null || before - free < 1024 ** 2 || !this.run.progress) return false;
    this.run.progress = { ...this.run.progress, at: this.now().toISOString() };
    if (this.run.stall) {
      this.run.stall = null;
      this.log('info', `moving again: ${this.run.progress.message}`);
    }
    return true;
  }

  /** Runs a long command with a stall check every config.stallCheckMs. */
  private async watched<T>(services: string[], downloading: boolean, work: Promise<T>): Promise<T> {
    this.downloadFree = null;
    // The disk's free space now, for the first check to compare with.
    if (downloading) void this.downloadMoved();
    const timer = setInterval(() => { void this.checkStall(services, downloading); }, this.deps.config.stallCheckMs);
    timer.unref?.();
    try {
      return await work;
    } finally {
      clearInterval(timer);
    }
  }

  /** Keeps the last few KB of a command's output for the stall check. */
  private keepOutput(chunk: string): void {
    this.commandOutput = (this.commandOutput + chunk).slice(-4096);
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

  private async docker(args: string[], opts: { env?: Record<string, string>; timeoutMs?: number; quiet?: boolean; onOutput?: (chunk: string) => void } = {}): Promise<CommandResult> {
    if (!opts.quiet) this.log('info', `$ docker ${args.join(' ')}`);
    const res = await this.deps.docker(args, {
      ...(opts.env ? { env: opts.env } : {}),
      ...(opts.onOutput ? { onOutput: opts.onOutput } : {}),
      timeoutMs: opts.timeoutMs ?? this.deps.config.commandTimeoutMs,
    });
    if (res.code !== 0 && !opts.quiet) this.log('warn', `exit ${res.code}: ${tail(res.stderr || res.stdout)}`);
    return res;
  }

  private compose(args: string[], opts: { env?: Record<string, string>; timeoutMs?: number; quiet?: boolean; onOutput?: (chunk: string) => void } = {}) {
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

  /** One query in the database container; null when psql fails. The query may not contain double quotes. */
  private async psql(query: string): Promise<string | null> {
    const res = await this.compose(
      ['exec', '-T', 'postgres', 'sh', '-c', `psql -X -q -tA -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "${query}"`],
      { quiet: true, timeoutMs: 30_000 },
    );
    return res.code === 0 ? res.stdout.trim() : null;
  }

  private async migrationCount(): Promise<number | null> {
    const out = await this.psql('select count(*) from _migrations');
    const n = Number(out);
    return out !== null && out !== '' && Number.isInteger(n) ? n : null;
  }

  /** The newest backup record; undefined: no table yet (the new app creates it); null: unreadable. */
  private async lastBackupRecord(): Promise<LastBackup | null | undefined> {
    const table = await this.psql(BACKUPS_TABLE_SQL);
    if (table === 'f') return undefined;
    if (table !== 't') return null;
    const out = await this.psql(LAST_BACKUP_SQL);
    return out === null ? null : parseLastBackup(out);
  }

  /**
   * Polls until `check` returns null (good) or the time runs out; returns
   * the last complaint. With `watch`: the containers are inspected every
   * config.observeEveryMs for the sub-state, and a stall is diagnosed.
   */
  private async waitFor(check: () => Promise<string | null>, timeoutMs: number, watch?: Watch): Promise<string | null> {
    const deadline = this.now().getTime() + timeoutMs;
    let last: string | null = 'not checked';
    let lastLogged = '';
    let seen: string | null = null;
    for (;;) {
      last = await check();
      if (last === null) return null;
      if (last !== lastLogged) {
        this.log('info', `waiting: ${last}`);
        lastLogged = last;
      }
      if (watch) {
        let readings: Readings | undefined;
        if (this.now().getTime() - this.lastObserved >= this.deps.config.observeEveryMs) {
          readings = await this.observe(watch.services.filter((s) => s === 'postgres' || this.services.includes(s)));
          seen = waitingFor(readings);
        }
        this.progress(watch.describe(last, seen));
        await this.checkStall(watch.services, false, readings);
      }
      if (this.now().getTime() >= deadline) return last;
      await this.sleep(this.deps.config.pollMs);
    }
  }

  /** Waiting for an app to answer: what the containers say, else what the health check says. */
  private appWatch(who: string): Watch {
    return { services: ['app', 'postgres'], describe: (detail, seen) => `waiting for ${who}: ${seen ?? detail}` };
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

    const release = this.deps.release;
    if (release && envGet(env, 'TAGAVE_PLAYER_IMAGE')) {
      this.fail('.env sets TAGAVE_PLAYER_IMAGE, which replaces the player image the release pins; remove that line and start the update again');
    }
    this.ownDump = ownDumpReason(env, await this.lastBackupRecord(), this.run.target);
    await this.checkSpace(this.run.target);

    if (release) {
      const { manifest } = release.verified;
      this.log('info', `signed manifest of ${manifest.version} checks out (key ${release.verified.keyId}); pulling every image by its digest for ${release.platform}`);
      const wanted = [...this.services, ...(this.hasUpdaterService(svc.stdout) ? ['updater'] : [])];
      const images = new Set<string>();
      for (const service of wanted) {
        const image = imageForService(manifest, service);
        if (!image) this.fail(`the signed manifest of ${manifest.version} pins no image for the service ${service}`);
        images.add(image);
      }
      const tracker = new PullProgress();
      const list = [...images];
      for (const [i, image] of list.entries()) {
        tracker.beginImage(i + 1, list.length, await this.layerSizes(`${withRegistry(manifest.images[image]!.ref, this.registry)}@${digestFor(manifest, image, release.platform)}`));
        this.progress(tracker.summary());
        this.commandOutput = '';
        await this.watched([], true, pullVerified(this.deps.docker, manifest, image, release.platform, (l, m) => this.log(l, m), this.deps.config.commandTimeoutMs, this.registry, (chunk) => {
          this.keepOutput(chunk);
          if (tracker.feed(chunk)) this.progress(tracker.summary());
        }));
      }
      return;
    }

    const wanted = [...this.services, ...(this.hasUpdaterService(svc.stdout) ? ['updater'] : [])];
    const pulling = new ComposePullProgress(wanted.length);
    this.progress(pulling.summary());
    const pull = await this.watched([], true, this.compose(['pull', ...wanted], {
      env: { TAGAVE_VERSION: this.run.target },
      onOutput: (chunk) => {
        this.keepOutput(chunk);
        if (pulling.feed(chunk)) this.progress(pulling.summary());
      },
    }));
    if (pull.code !== 0) {
      const text = `${pull.stderr}\n${pull.stdout}`;
      if (/no matching manifest|platform/i.test(text)) this.fail(`${this.run.target} has no image for this computer's architecture`);
      if (/not found|manifest unknown|does not exist/i.test(text)) this.fail(`${this.run.target} is not published (${this.registry})`);
      this.fail(`downloading the ${this.run.target} images failed: ${tail(text, 3)}`);
    }
  }

  /** The compressed layers of an image, for the download's byte count; null when the registry does not say within 10 s. */
  private async layerSizes(ref: string): Promise<Layer[] | null> {
    try {
      return await (this.deps.layers ?? registryClient(fetch))(ref, AbortSignal.timeout(10_000));
    } catch {
      return null;
    }
  }

  private hasUpdaterService(servicesOut: string): boolean {
    return servicesOut.split('\n').some((s) => s.trim() === 'updater');
  }

  /**
   * What the target's heavy migrations (heavy-migrations.ts) write to the
   * database, read from its app image, which preflight pulled. Undefined
   * when there are none or nothing can be read: the new app checks again
   * before it migrates.
   */
  private async heavyMigrationLoad(): Promise<{ bytes: number; what: string } | undefined> {
    const env = this.deps.release ? { TAGAVE_VERSION: this.run.target, ...envPins(this.deps.release.verified.manifest, this.deps.release.platform) } : { TAGAVE_VERSION: this.run.target };
    const ref = await this.compose(['config', '--images', 'app'], { env, quiet: true, timeoutMs: 60_000 });
    const image = ref.code === 0 ? ref.stdout.split('\n').map((l) => l.trim()).find(Boolean) : undefined;
    if (!image) return undefined;
    const files = await this.docker(['run', '--rm', '--pull', 'never', '--network', 'none', '--entrypoint', 'ls', image, IMAGE_MIGRATIONS_DIR], { quiet: true, timeoutMs: 60_000 });
    const applied = await this.psql('select name from _migrations');
    if (files.code !== 0 || applied === null) {
      this.log('info', 'space: could not compare the migrations of the new version with the database; the new app checks the room its migrations need before it applies them');
      return undefined;
    }
    let bytes = 0;
    const what: string[] = [];
    for (const { name, migration } of pendingHeavy(files.stdout, applied)) {
      const out = await this.psql(migration.bytesSql);
      const n = Number(out);
      if (out === null || !Number.isFinite(n) || n < 0) {
        this.log('info', `space: could not measure what ${name} moves; the new app checks before it applies it`);
        continue;
      }
      bytes += n * migration.factor;
      what.push(`${migration.what} (${name}, ${formatBytes(n)} × ${migration.factor})`);
    }
    return bytes > 0 ? { bytes, what: what.join(', ') } : undefined;
  }

  /** Fails the step when the disk cannot take what comes next; `target` null: the images are pulled already. */
  private async checkSpace(target: string | null): Promise<void> {
    const env = this.originals.get('.env') ?? '';
    // Known only once the new app image is here.
    const migration = target === null ? await this.heavyMigrationLoad() : undefined;
    const space = await checkSpace(
      {
        docker: (args, opts) => this.docker(args, { ...opts, quiet: true }),
        statfs: this.deps.statfs ?? statfs,
        layers: this.deps.layers ?? registryClient(fetch),
        log: (level, message) => this.log(level, message),
      },
      {
        target,
        imageCount: this.services.length + 1,
        ...(this.deps.release && target !== null ? { targetEnv: envPins(this.deps.release.verified.manifest, this.deps.release.platform) } : {}),
        dockerHeadroom: this.deps.config.minFreeBytes,
        backupsOnHost: backupsOnHostFolder(envGet(env, 'TAGAVE_BACKUP_DIR') || envGet(env, 'LINER_BACKUP_DIR')),
        // One dump per update: the new app's, or the updater's own, and then
        // the new app is started with TAGAVE_SKIP_PREMIGRATE_BACKUP=1.
        backupCopies: 1,
        ...(migration ? { migration } : {}),
      },
    );
    if (space.problem) this.fail(target === null ? `${space.problem} (measured again after the new images were downloaded)` : space.problem);
  }

  private async backup(): Promise<void> {
    this.migrationsBefore = await this.migrationCount();
    this.log('info', `migrations applied: ${this.migrationsBefore ?? 'unknown'}`);
    const last = await this.lastBackupRecord();
    this.backupsMaxId = last === undefined ? 0 : last?.maxId ?? null;
    // Without both readings a roll back could not tell whether the database
    // changed, or find the app's dump: the updater's own is the rollback point.
    if (this.ownDump === null && (this.migrationsBefore === null || this.backupsMaxId === null)) {
      this.ownDump = 'the database could not be read just before the update, so the backup the new app takes could not be found afterwards';
    }
    await this.checkSpace(null);
    if (this.ownDump === null) {
      this.log('info', 'no dump of its own: the new app backs the database up right before it changes it, and a roll back restores that backup');
      return;
    }
    this.log('info', `the updater backs the database up itself: ${this.ownDump}`);
    this.progress('the updater backs up the database');
    let res = await this.watched(['app', 'postgres'], false, this.compose(['exec', '-T', 'app', ...DOCTOR, 'backup', '--kind', 'before-update', '--json']));
    if (res.code !== 0 && /unknown option --kind/.test(`${res.stderr}${res.stdout}`)) {
      // The running app's doctor is from before --kind (0.8 or older): its dump is filed as manual.
      this.log('info', 'the running app does not know --kind yet; its dump is listed under Manual in Settings › Backups');
      res = await this.watched(['app', 'postgres'], false, this.compose(['exec', '-T', 'app', ...DOCTOR, 'backup', '--json']));
    }
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
    this.ownDumpPath = path;
    this.run.backup = path;
  }

  /**
   * The dump a roll back restores: the first one the new app recorded during
   * this run (a restart after a failed migration reuses it and records
   * nothing new), else the updater's own. `why` says why there is none.
   */
  private async rollbackDump(): Promise<{ paths: string[] } | { why: string }> {
    const paths: string[] = [];
    let why = 'the record of the backups the app takes before it migrates could not be read before the update';
    if (this.backupsMaxId !== null) {
      const out = await this.psql(firstBackupSinceSql(this.backupsMaxId));
      const rec = out === null ? null : parseRecordedDump(out);
      if (rec?.status === 'ok' && rec.path) paths.push(rec.path);
      if (out === null) why = 'the database does not answer, so the backup the new app took cannot be looked up';
      else if (rec?.status === 'skipped') why = 'the new app migrated without a backup (TAGAVE_SKIP_PREMIGRATE_BACKUP)';
      else why = 'the new app recorded no backup during this update';
    }
    if (this.ownDumpPath) paths.push(this.ownDumpPath);
    return paths.length > 0 ? { paths } : { why };
  }

  /**
   * True when the record proves the new app applied nothing: runMigrations
   * records its backup (or its skip) before the first file, so no row above
   * the one read before the update means no file ran. Only without a dump
   * of the updater's own, which a roll back would then not need either.
   */
  private async provenUnmigrated(): Promise<boolean> {
    if (this.backupsMaxId === null || this.ownDumpPath) return false;
    const out = await this.psql(firstBackupSinceSql(this.backupsMaxId));
    return out !== null && parseRecordedDump(out) === null && out.trim() === '';
  }

  /** A dump to name for a restore by hand: this run's first record, else the newest recorded one. */
  private async dumpToName(): Promise<string | null> {
    if (this.backupsMaxId !== null) {
      const first = parseRecordedDump((await this.psql(firstBackupSinceSql(this.backupsMaxId))) ?? '');
      if (first?.path) return first.path;
    }
    const newest = await this.psql("select coalesce((select path from _migration_backups where status = 'ok' and path is not null order by id desc limit 1), '')");
    return newest ? newest : this.ownDumpPath;
  }

  /** Reads the dump back with pg_restore --list (in a one-off app container), as the restore will. */
  private async dumpReadable(path: string): Promise<string | null> {
    const res = await this.compose(['run', '--rm', '--no-deps', '-T', '--entrypoint', 'pg_restore', 'app', '--list', path], { quiet: true, timeoutMs: 10 * 60_000 });
    if (res.code === 0 && res.stdout.trim() !== '') return null;
    return tail(res.stderr || res.stdout || `pg_restore exited ${res.code}`, 2);
  }

  /** After the new app answered: the dump it took before it migrated is the run's backup. */
  private async noteAppDump(): Promise<void> {
    if (this.backupsMaxId === null) return;
    const out = await this.psql(firstBackupSinceSql(this.backupsMaxId));
    const rec = out === null ? null : parseRecordedDump(out);
    if (rec?.status === 'ok' && rec.path) {
      this.run.backup = rec.path;
      this.log('info', `the new app backed the database up before it changed it: ${rec.path}`);
    } else if (rec?.status === 'skipped') {
      if (this.ownDumpPath) this.log('info', `the new app changed the database; the updater's ${this.ownDumpPath} is the backup from before it`);
      else this.log('warn', 'the new app changed the database without a backup (TAGAVE_SKIP_PREMIGRATE_BACKUP)');
    } else if (rec === null && out !== null) {
      this.log('info', 'the new app had no database changes to apply, so it took no backup');
    }
  }

  private async config(): Promise<void> {
    this.playerImageBefore = await this.playerImage();
    for (const name of COMPOSE_FILES) {
      const text = await readText(join(this.deps.installDir, name));
      if (text !== null) this.originals.set(name, text);
    }
    this.changed = true;
    // With a signed manifest: the updater image preflight pulled and checked, by digest.
    const release = this.deps.release;
    const updaterKey = release ? imageForService(release.verified.manifest, 'updater') : null;
    const image = release && updaterKey
      ? `${withRegistry(release.verified.manifest.images[updaterKey]!.ref, this.registry)}@${digestFor(release.verified.manifest, updaterKey, release.platform)}`
      : `${this.registry}/tagave-updater:${this.run.target}`;
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
    env = envSet(env, 'TAGAVE_VERSION', this.run.target);
    if (this.deps.release) env = await this.pinRelease(env);
    await writeFileAtomic(this.envPath, env);
    this.log('info', `TAGAVE_VERSION=${this.run.target} in .env (was ${this.run.from}; old file kept as .env.bak)`);
    const check = await this.compose(['config', '--quiet'], { timeoutMs: 60_000 });
    if (check.code !== 0) this.fail(`docker compose rejects the new configuration: ${tail(check.stderr, 3)}`);
    if (this.deps.release) await this.checkPinned();
    this.playerImageAfter = await this.playerImage();
    if (this.playerImageBefore !== null) {
      this.log('info', this.playerImageChanges()
        ? `player image: ${this.playerImageBefore} -> ${this.playerImageAfter}`
        : `player image unchanged (${this.playerImageBefore})`);
    }
  }

  /** Keeps a file as it is now (or notes it is new), so a roll back puts it back. */
  private async keep(name: string): Promise<void> {
    if (this.originals.has(name) || this.created.includes(name)) return;
    const text = await readText(join(this.deps.installDir, name));
    if (text === null) this.created.push(name);
    else this.originals.set(name, text);
  }

  /**
   * The release's digests in .env (and stale pins out), the module compose
   * files of the modules that are on rendered for the new release, and the
   * signed manifest kept next to the install for Settings › Modules.
   */
  private async pinRelease(envIn: string): Promise<string> {
    const { verified, platform } = this.deps.release!;
    const { manifest } = verified;
    let env = envIn;
    const pins = envPins(manifest, platform);
    for (const key of envKeys(env, /^TAGAVE_DIGEST_/)) if (!(key in pins)) env = envUnset(env, key);
    for (const [key, digest] of Object.entries(pins)) env = envSet(env, key, digest);
    this.log('info', `pinned ${Object.keys(pins).length} images by digest in .env (${Object.keys(pins).join(', ')})`);
    for (const entry of manifest.modules) {
      if (!entry.compose || !isOn(envIn, entry)) continue;
      const file = moduleComposeFile(entry);
      await this.keep(file);
      await mkdirKeepingOwner(join(this.deps.installDir, MODULES_DIR), 0o755);
      await writeFileKeepingOwner(join(this.deps.installDir, file), renderModuleCompose(manifest, entry, platform), { fallbackMode: 0o644 });
      this.log('info', `${file} written for ${manifest.version}`);
    }
    await this.keep(MANIFEST_FILE);
    await this.keep(SIGNATURE_FILE);
    await writeFileKeepingOwner(join(this.deps.installDir, MANIFEST_FILE), verified.text, { fallbackMode: 0o644 });
    await writeFileKeepingOwner(join(this.deps.installDir, SIGNATURE_FILE), verified.signature, { fallbackMode: 0o644 });
    return env;
  }

  /** Every service runs exactly the image the signed manifest pins: no floating tag. */
  private async checkPinned(): Promise<void> {
    const { manifest } = this.deps.release!.verified;
    const res = await this.compose(['config', '--format', 'json'], { quiet: true, timeoutMs: 60_000 });
    let services: Record<string, { image?: string }> = {};
    try {
      services = (JSON.parse(res.stdout) as { services?: Record<string, { image?: string }> }).services ?? {};
    } catch {
      this.fail('docker compose did not print the new configuration');
    }
    for (const [name, svc] of Object.entries(services)) {
      const image = imageForService(manifest, name);
      if (!image) this.fail(`the service ${name} is not in the signed manifest of ${manifest.version}`);
      const want = digestFor(manifest, image, this.deps.release!.platform);
      if (!(svc.image ?? '').endsWith(`@${want}`)) {
        this.fail(`the service ${name} would run ${svc.image ?? 'no image'}, not ${manifest.images[image]!.ref}@${want} as the signed manifest pins (the compose files here do not read TAGAVE_DIGEST_*?)`);
      }
    }
    this.log('info', 'every service runs the image the signed manifest pins');
  }

  private async pull(): Promise<void> {
    const pulling = new ComposePullProgress(this.services.length);
    this.progress(pulling.summary());
    const res = await this.watched([], true, this.compose(['pull', ...this.services], {
      onOutput: (chunk) => {
        this.keepOutput(chunk);
        if (pulling.feed(chunk)) this.progress(pulling.summary());
      },
    }));
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
    this.progress('starting the new app');
    // The updater's own dump is the rollback point: the new app takes none on
    // this boot, so the update writes one before-update dump. The next
    // `up -d` (the workers) starts it again without the setting.
    const skip = this.ownDumpPath ? { env: { TAGAVE_SKIP_PREMIGRATE_BACKUP: '1' } } : {};
    if (this.ownDumpPath) this.log('info', 'the new app starts without a backup of its own this once (TAGAVE_SKIP_PREMIGRATE_BACKUP=1): the updater took one');
    const up = await this.watched(['postgres', 'app'], false, this.compose(['up', '-d', 'app'], skip));
    if (up.code !== 0) this.fail(`the new app did not start: ${tail(up.stderr, 3)}`);
    this.log('info', 'waiting for the new app (it backs up and updates the database before it answers)');
    const appIssue = await this.waitFor(this.appOn(this.run.target, null, false), this.deps.config.healthTimeoutMs, this.appWatch('the app'));
    if (appIssue) this.fail(`the app did not answer healthy on ${this.run.target}: ${appIssue}`);
    await this.noteAppDump();
    if (this.hasPlayer()) this.playerStarted = true;
    this.progress('starting the workers');
    const rest = await this.watched(this.workers(), false, this.compose(['up', '-d', ...this.services]));
    if (rest.code !== 0) this.fail(`docker compose could not start the workers: ${tail(rest.stderr, 3)}`);
    return startedAt;
  }

  private async verify(since: Date): Promise<void> {
    const target = this.run.target;
    const issue = await this.waitFor(this.appOn(target, since, true), this.deps.config.healthTimeoutMs, {
      services: ['app', ...this.workers()],
      describe: (detail, seen) => {
        const m = /^(\d+) of (\d+) workers report/.exec(detail);
        if (m) return `workers: ${m[1]} of ${m[2]} on the new version`;
        return `waiting for the app: ${seen ?? detail}`;
      },
    });
    if (issue) this.fail(`not every part reports ${target}: ${issue}`);
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
    let filesBack = false;
    let restoreFrom: string | null = null;
    try {
      if (this.newAppStarted) {
        // Stop the new app (and the workers) before reading anything: a
        // running app may be dumping, migrating or crash-looping into its
        // next attempt, and a file it commits after the reading would leave
        // the old version on a partly migrated database.
        const stop = await this.compose(['stop', 'app', ...this.workers()]);
        if (stop.code !== 0) throw new KeepNewVersion(`the new app could not be stopped to check whether it changed the database (${tail(stop.stderr || stop.stdout, 2)})`);
      }
      const after = this.newAppStarted ? await this.migrationCount() : this.migrationsBefore;
      const moved = after === null || this.migrationsBefore === null || after !== this.migrationsBefore;
      const needsRestore = this.newAppStarted && moved && !(await this.provenUnmigrated());
      this.log('info', `migrations before ${this.migrationsBefore ?? 'unknown'}, now ${after ?? 'unknown'}`);

      if (needsRestore) {
        // Find and read the dump before anything is put back: without one,
        // the old version must not start on the changed database.
        const dump = await this.rollbackDump();
        if ('why' in dump) throw new KeepNewVersion(`the database may have been changed, and there is no backup from before the update to restore: ${dump.why}`);
        const problems: string[] = [];
        for (const path of dump.paths) {
          const unreadable = await this.dumpReadable(path);
          if (!unreadable) {
            restoreFrom = path;
            break;
          }
          problems.push(`${path} (${unreadable})`);
          this.log('warn', `${path} cannot be read back: ${unreadable}`);
        }
        if (!restoreFrom) throw new KeepNewVersion(`the database may have been changed, and its backup from before the update cannot be read: ${problems.join('; ')}`);
        this.run.backup = restoreFrom;
      }

      for (const [name, text] of this.originals) {
        await writeFileAtomic(join(this.deps.installDir, name), text, false);
      }
      for (const name of this.created) await unlink(join(this.deps.installDir, name)).catch(() => undefined);
      filesBack = true;
      this.log('info', `put back .env (TAGAVE_VERSION=${envGet(this.originals.get('.env') ?? '', 'TAGAVE_VERSION') ?? this.run.from}) and the compose files`);

      if (restoreFrom) {
        this.log('warn', `the new version changed the database; restoring ${restoreFrom}, the backup from before it did`);
        this.progress(`restoring ${restoreFrom}`);
        const res = await this.watched(['postgres'], false, this.compose(['run', '--rm', '--no-deps', '-T', 'app', ...DOCTOR, 'restore', restoreFrom, '--yes', '--json']));
        if (res.code !== 0) throw new Error(`tagave-doctor restore failed: ${tail(res.stderr || res.stdout, 3)}`);
        restored = true;
        let kept = 'under another name';
        try {
          const json = JSON.parse(res.stdout.slice(res.stdout.indexOf('{'))) as { previousDatabase?: string | null };
          if (json.previousDatabase) kept = `as ${json.previousDatabase} (drop it once you are happy)`;
        } catch {
          /* keep the generic wording */
        }
        this.log('info', `restored ${restoreFrom}; the changed database is kept ${kept}`);
      }

      if (this.playerSnapshot && this.playerStarted) await this.restorePlayer();

      const up = await this.compose(['up', '-d', 'app']);
      if (up.code !== 0) throw new Error(`the old app did not start: ${tail(up.stderr, 3)}`);
      const from = /^\d+\.\d+\.\d+/.test(this.run.from) ? this.run.from : null;
      const issue = await this.waitFor(this.appOn(from, null, false), this.deps.config.healthTimeoutMs, this.appWatch(`${this.run.from}`));
      if (issue) throw new Error(`the old version did not answer healthy: ${issue}`);
      const rest = await this.compose(['up', '-d', ...this.services]);
      if (rest.code !== 0) throw new Error(`the workers did not start: ${tail(rest.stderr, 3)}`);
      healthy = true;
      this.end('rollback', 'done');
      this.run.status = 'rolled_back';
      this.run.reason = redact(reason);
      this.log('warn', `rolled back to ${this.run.from}${restored ? ' with the database restored' : ''}`);
    } catch (err) {
      this.end('rollback', 'failed');
      this.run.status = 'rollback_failed';
      if (err instanceof KeepNewVersion) {
        // Nothing was put back: the new version matches the database it changed.
        const up = await this.compose(['up', '-d', ...this.services]);
        const named = await this.dumpToName().catch(() => null);
        this.run.reason = redact(`${reason}. Not rolled back: ${err.message}. ${this.run.from} must not run on a database ${this.run.target} changed, so ${this.run.target} stays in place${up.code === 0 ? ' and was started again' : ''}. ${
          named ? `To go back by hand, restore ${named}` : 'No backup from before the update could be looked up'} (docs/operations.md, Roll back an update)`);
        this.log('error', `not rolled back: ${err.message}`);
        this.log('error', `${this.run.target} stays in place (TAGAVE_VERSION=${this.run.target} in .env). Look at docker compose logs app, or restore a backup from before the update by hand and set TAGAVE_VERSION=${this.run.from} (docs/operations.md, Roll back an update)`);
      } else {
        this.run.reason = redact(`${reason}. The roll back did not finish: ${(err as Error).message}`);
        this.log('error', `roll back failed: ${(err as Error).message}`);
        this.log('error', restoreFrom && !restored && filesBack
          ? `the app and workers are stopped, and the database is still the one ${this.run.target} changed: do not start ${this.run.from} on it. By hand, in the install folder: restore ${restoreFrom} with tagave-doctor restore (docs/operations.md, Roll back an update), then docker compose up -d; or set TAGAVE_VERSION=${this.run.target} in .env again and docker compose up -d`
          : `by hand, in the install folder: check TAGAVE_VERSION in .env is ${this.run.from}, then docker compose up -d${
            this.run.backup ? `; if the app refuses the database, restore ${this.run.backup} with tagave-doctor restore (docs/operations.md, Roll back)` : ''}`);
      }
    }
    this.run.rollback = {
      version: filesBack ? envGet(this.originals.get('.env') ?? '', 'TAGAVE_VERSION') ?? this.run.from : this.run.target,
      restoredDatabase: restored,
      healthy,
    };
  }

  /** Removes the images older than the version this update came from. Warns, never fails the update. */
  private async cleanOldImages(): Promise<void> {
    const free = async () => {
      const s = await (this.deps.statfs ?? statfs)('/');
      return s.bavail * s.bsize;
    };
    try {
      const freeBefore = await free().catch(() => null);
      const res = await removeOldImages(
        // One summary line instead of every docker call.
        (args, opts) => this.docker(args, { ...opts, quiet: true }),
        (images) => [
          ...tagaveGroups(this.registry, this.run.from, this.run.target, images),
          ...playerGroups(withoutDigest(this.playerImageBefore), withoutDigest(this.playerImageAfter)),
        ],
      );
      if (res.removed.length > 0) {
        const freeAfter = await free().catch(() => null);
        const gained = freeBefore !== null && freeAfter !== null && freeAfter > freeBefore ? `, ${formatBytes(freeAfter - freeBefore)} more free on disk` : '';
        this.log('info', `removed ${res.removed.length} old image${res.removed.length === 1 ? '' : 's'} (${formatBytes(res.bytes)} by Docker's count${gained}): ${res.removed.join(', ')}`);
      } else {
        this.log('info', 'no old images to remove');
      }
      if (res.inUse.length > 0) this.log('info', `kept, a container uses them: ${res.inUse.join(', ')}`);
      for (const f of res.failed) this.log('warn', `could not remove ${f.ref}: ${f.error}`);
    } catch (err) {
      this.log('warn', `removing old images failed (${(err as Error).message}); the update itself is done`);
    }
  }

  /** The image IDs of this updater's own container and of the target's updater image; null when either is unknown. */
  private async updaterImages(): Promise<{ running: string; target: string } | null> {
    const ps = await this.compose(['ps', '-q', 'updater'], { quiet: true, timeoutMs: 30_000 });
    const own = ps.code === 0 ? ps.stdout.trim().split('\n')[0]?.trim() : '';
    if (!own) return null;
    const running = await this.docker(['inspect', '-f', '{{.Image}}', own], { quiet: true, timeoutMs: 30_000 });
    const ref = await this.compose(['config', '--images', 'updater'], { quiet: true, timeoutMs: 30_000 });
    const targetRef = ref.code === 0 ? ref.stdout.trim().split('\n')[0]?.trim() : '';
    if (running.code !== 0 || !targetRef) return null;
    const target = await this.docker(['image', 'inspect', '-f', '{{.Id}}', targetRef], { quiet: true, timeoutMs: 30_000 });
    if (target.code !== 0) return null;
    const a = running.stdout.trim();
    const b = target.stdout.trim();
    return a && b ? { running: a, target: b } : null;
  }

  /** The hand-over container of this run, by its label (null: docker did not answer). */
  private async handoverContainer(): Promise<string | null | undefined> {
    const res = await this.docker(['ps', '-aq', '--filter', `label=${HANDOVER_LABEL}=${this.run.id}`], { quiet: true, timeoutMs: 30_000 });
    if (res.code !== 0) return null;
    return res.stdout.trim().split('\n')[0]?.trim() || undefined;
  }

  private async replaceSelf(): Promise<void> {
    const images = await this.updaterImages();
    if (images && images.running === images.target) {
      this.log('info', `the updater image did not change (${images.target.slice(0, 19)}); the updater keeps running as it is`);
      await this.persist();
      return;
    }
    // A one-off container of the updater service, on the new image, recreates
    // the updater service container; this process is the one being replaced,
    // so it must not do that itself. From here until the replacement is up,
    // the updater refuses new runs, and this process writes nothing more to
    // state.json unless the hand-over fails (self-replace.ts).
    this.log('info', 'handing over to the updater on the new version; it restarts in a few seconds');
    await this.persist();
    this.handedOver = true;
    await this.deps.selfReplace?.begin(this.run.target, this.run.id);
    const res = await this.deps.docker(
      ['compose', 'run', '-d', '--rm', '--no-deps', '--label', `${HANDOVER_LABEL}=${this.run.id}`, '--entrypoint', 'sh', 'updater', '-c', 'sleep 3; docker compose up -d --no-deps updater'],
      { timeoutMs: 60_000 },
    );
    const timedOut = res.code !== 0 && /timed out after/.test(res.stderr);
    let id: string | null | undefined = res.code === 0 ? res.stdout.trim().split('\n').at(-1)?.trim() || undefined : undefined;
    if (!id) id = await this.handoverContainer();
    if (id === undefined && res.code !== 0 && !timedOut) {
      // Docker says it never created the container: nothing will replace this process.
      await this.handoverFailed(`the one-off container that replaces it did not start (${tail(res.stderr || res.stdout, 2)})`);
      return;
    }
    // Started, or unknown (a timeout): keep refusing until the container
    // exits with this process still alive, the backstop, or the stale limit.
    this.handover = this.watchHandover(id ?? null);
  }

  private async watchHandover(id: string | null): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const backstop = new Promise<'backstop'>((resolve) => {
      timer = setTimeout(() => resolve('backstop'), this.deps.config.handoverBackstopMs);
      timer.unref?.();
    });
    const exited = id
      ? Promise.all([
        this.deps.docker(['wait', id], { timeoutMs: this.deps.config.handoverBackstopMs + 60_000 }),
        this.deps.docker(['logs', '-f', '--tail', '6', id], { timeoutMs: this.deps.config.handoverBackstopMs + 60_000 }),
      ]).then(([wait, logs]) => ({ wait, logs }))
      : new Promise<never>(() => undefined);
    const result = await Promise.race([backstop, exited]);
    clearTimeout(timer);
    if (result === 'backstop') {
      await this.handoverFailed(`the hand-over did not replace it within ${Math.round(this.deps.config.handoverBackstopMs / 1000)} s`);
      return;
    }
    const code = result.wait.code === 0 && /^\d+$/.test(result.wait.stdout.trim()) ? result.wait.stdout.trim() : '?';
    const lines = tail(`${result.logs.stdout}\n${result.logs.stderr}`, 6);
    await this.handoverFailed(`hand-over container exited (code ${code})`, lines);
  }

  /** This process is still alive, so it was not replaced: open the gate again and say so. */
  private async handoverFailed(reason: string, lines = ''): Promise<void> {
    this.handedOver = false;
    await this.deps.selfReplace?.abort(reason);
    this.log('warn', `the updater could not replace itself: ${reason}. It moves to the new version at its next restart (docker compose up -d updater)${lines ? `. Its last lines: ${lines}` : ''}`);
    await this.persist();
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
      if (this.deps.release) {
        await mkdirKeepingOwner(join(this.deps.installDir, '.updater'), 0o700).catch(() => undefined);
        await writeFileKeepingOwner(join(this.deps.installDir, RELEASE_FLOOR_FILE), `${this.run.target}\n`, { fallbackMode: 0o600 })
          .catch((err: Error) => this.log('warn', `could not note ${this.run.target} as the newest release run here: ${err.message}`));
      }
    } catch (err) {
      const reason = err instanceof StepFailed || err instanceof ReleaseRefused ? err.message : `unexpected error: ${(err as Error).message}`;
      this.end(current, 'failed');
      this.log('error', reason);
      for (const s of this.run.steps) if (s.status === 'pending' && s.id !== 'rollback') s.status = 'skipped';
      if (this.changed) {
        await this.rollbackAll(reason);
      } else {
        this.end('rollback', 'skipped');
        this.run.status = 'failed';
        this.run.reason = redact(`${reason}. Nothing was changed.`);
      }
    }
    if (this.run.status === 'succeeded') await this.cleanOldImages();
    this.run.progress = null;
    this.run.stall = null;
    this.run.finishedAt = this.now().toISOString();
    await this.persist();
    // replaceSelf writes the run once more before it hands over, and not after.
    if (this.run.status === 'succeeded' && this.deps.config.selfUpdate) await this.replaceSelf();
    return this.run;
  }
}
