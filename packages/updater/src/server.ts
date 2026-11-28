/**
 * The updater's HTTP API. It listens on the compose network the app shares
 * with it (no published port); every request must carry the app's signature
 * (token.ts).
 *
 *   GET  /v1/status   the updater's version, the install's TAGAVE_VERSION,
 *                     and the current or last run
 *   POST /v1/update   {"version", "manifest", "signature"}: start an update
 *                     (202) to the release the signed manifest describes;
 *                     422 when the manifest does not check out (release.ts),
 *                     409 while a run is under way or while the updater
 *                     restarts itself on a new version (self-replace.ts)
 *   POST /v1/release  {"manifest", "signature"}: the signed manifest of the
 *                     release that runs here, kept next to the install once
 *                     it checks out (the app fetches it from the release)
 *   GET  /v1/modules  the module catalogue of that release, each module's
 *                     state, and the current or last module run
 *   POST /v1/modules/<id>/enable           turn a module on (202)
 *   POST /v1/modules/<id>/disable          {"deleteData": false, "deleteHistory": false}: turn it off (202)
 *   POST /v1/repair   (empty body): check every part and fix what it safely
 *                     can (202, repair.ts); 409 while an update, a module
 *                     run, a repair or a self-replace runs. A repair that
 *                     waits for the music share is restarted at check.
 *
 * GET /v1/status also says what each part is doing (`parts`, read with short
 * limits and kept 10 s), the last repair (`repair`) and what the music
 * share's fstab line means at boot (`musicBoot`, kept 10 minutes).
 *
 * One run at a time: an update, a module run and a running repair refuse
 * each other (409), and all wait while the updater replaces itself or the
 * music self-heal runs an attempt (music-heal.ts; an update's own repair
 * waits for that attempt to settle, then starts). A
 * repair that waits for the music share blocks nothing; its watcher pauses
 * while anything else moves containers. Across processes (this service and
 * the installer's one-off cli.js repair) a repair, each resume of a waiting
 * one and each self-heal attempt hold .updater/repair.lock (repair-lock.ts):
 * a second start is refused as running, never failed.
 */
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { MusicBoot, PartState, RepairRun, UpdateRun, UpdaterStatus } from '@tagave/shared/updater';
import type { ModuleRun, UpdaterModules } from '@tagave/shared/modules';
import { ModuleOperation, moduleStatuses, newModuleRun, type ModuleConfig } from './modules.js';
import { dockerArch } from './preflight-space.js';
import { MANIFEST_FILE, ReleaseRefused, SIGNATURE_FILE, platformOf, verifyRelease, type TrustedKey, type VerifiedRelease } from './release.js';
import { writeFileKeepingOwner } from './safe-write.js';
import { envGet, readText, writeFileAtomic } from './envFile.js';
import { mkdirKeepingOwner } from './safe-write.js';
import { HANDOVER_LABEL, SelfReplaceGate, parseState, serializeState, type SelfReplaceLog, type SelfReplaceMarker } from './self-replace.js';
import type { AppProbe, Runner } from './runner.js';
import { SIGNATURE_HEADER, SignatureVerifier, TIME_HEADER } from './token.js';
import { RELEASE_FLOOR_FILE, Update, newRun, type UpdateConfig } from './update.js';
import type { MusicProber } from './music-probe.js';
import type { RemountResult } from './music-heal.js';
import { Parts, readParts } from './parts.js';
import { hasParentLayout, moveLayout, musicBootOf, musicBootWanted, readFstab } from './music-layout.js';
import { partName } from './progress.js';
import { DEFAULT_REPAIR_CONFIG, REPAIR_STATE_FILE, Repair, newRepairRun, type RepairConfig, type RepairDeps } from './repair.js';
import { RepairLock, type LockHolder, type Release } from './repair-lock.js';

/** Same rule as @tagave/shared UPDATE_TARGET_RE (kept here so the image needs no runtime packages). */
const TARGET_RE = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]{1,40})?$/;
/** A signed manifest travels in the body. */
const MAX_BODY = 600 * 1024;
const MODULE_PATH_RE = /^\/v1\/modules\/([a-z][a-z0-9-]{0,30})\/(enable|disable)$/;
export const STATE_DIR = '.updater';
/** How long a reading of the parts is served before it is read again. */
const PARTS_CACHE_MS = 10_000;
/** The longest a status call waits for the parts; a part with no answer by then reads stuck. */
const PARTS_DEADLINE_MS = 6_000;
/** The limit on one read of the service list (`compose config --services`). */
const SERVICES_READ_MS = 5_000;
/** The limit on one read of the service list when nobody waits for the answer (the repair of an interrupted update after a start). */
const SERVICES_PATIENT_READ_MS = 30_000;
/** How many such reads before it gives up, and the pause between them. */
const SERVICES_PATIENT_TRIES = 3;
const SERVICES_RETRY_MS = 3_000;
/** The longest a status call waits, for everything it reads; the app gives up on /v1/status after 8 s. */
const STATUS_DEADLINE_MS = 6_000;
/** A service list that comes with less of the status budget left counts as late for that call (no parts that would all read stuck). */
const LATE_LIST_MS = 500;
/** How long a reading of the host's fstab (musicBoot) is served before it is read again. */
const BOOT_CACHE_MS = 10 * 60_000;
/** A failed read (null) is tried again sooner: the helper may have failed once. */
const BOOT_FAILED_CACHE_MS = 60_000;
/** A repair.json marked running by another process (the installer's one-off) counts for this long. */
const ELSEWHERE_MS = 60 * 60_000;
/** How often the service reads repair.json for a waiting repair another process left (followRepairFile). */
const REPAIR_FILE_POLL_MS = 60_000;
const RESTARTED_DURING_REPAIR = 'The updater restarted during the repair. Press Repair again.';
/** A repair that ended without an end: stale (R29), or stopped by SIGINT or SIGTERM in cli.js. */
export const STOPPED_REPAIR = 'The repair stopped. Press Repair again.';
/**
 * The one music share layout move after a hand-over (layoutAfterHandover):
 * {"version", "done"}. Written with done false before the restart marker is
 * cleared, and done true once the move was tried, so a restart neither runs
 * it twice nor skips it.
 */
export const HANDOVER_LAYOUT_FILE = `${STATE_DIR}/layout-after-handover.json`;
/** While a repair, an update, a module run or a self-heal attempt runs: this many tries, this far apart (10 minutes in all). */
const HANDOVER_LAYOUT_RETRY = { tries: 10, gapMs: 60_000 };
/** The one line when every try found something else running. */
const HANDOVER_LAYOUT_SKIPPED = 'the music share layout was not checked after the update: a repair or another run kept going. The next Repair or update checks it';

/** What `p` gives if it answers before `end` (a Date.now() time), else `late()`; `p` goes on in the background. */
async function beforeEnd<T>(end: number, p: Promise<T>, late: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ late: true }>((resolve) => {
    timer = setTimeout(() => resolve({ late: true }), Math.max(0, end - Date.now()));
    (timer as { unref?: () => void }).unref?.();
  });
  try {
    const won = await Promise.race([p.then((value) => ({ late: false as const, value })), timeout]);
    return won.late ? late() : won.value;
  } finally {
    clearTimeout(timer);
  }
}

/** Which run holds the one run slot while it starts. */
type Claim = 'update' | 'module' | 'repair';

export interface UpdaterOptions {
  installDir: string;
  appSecret: string;
  version: string;
  docker: Runner;
  app: AppProbe;
  config: UpdateConfig;
  now?: () => Date;
  log?: SelfReplaceLog;
  /** The public release keys (release.ts); none refuses every release. */
  keys: TrustedKey[];
  /** Docker's architecture here (amd64, arm64); default: this process's. */
  arch?: string;
  /** Module runs; default from `config`. */
  moduleConfig?: Partial<ModuleConfig>;
  /** Reads the music share for an update whose parts will not stop or start; the healer shares it (main.ts). */
  music?: MusicProber | null;
  /** Tells the app how a repair settled (its audit entry); never throws. */
  report?: RepairDeps['report'];
  /** The app's own music check: true when it says the music folder is unmounted. */
  musicUnmounted?: RepairDeps['musicUnmounted'];
  /** The updater's own image, for a repair's one-time move to the parent music layout (main.ts, cli.ts: selfImage); absent: no move. */
  layoutImage?: RepairDeps['layoutImage'];
  /** Repair limits; default DEFAULT_REPAIR_CONFIG with `config`'s health limit and poll. */
  repairConfig?: Partial<RepairConfig>;
  /** How long a status call waits for the parts (default 6 s, never more than the time left in its budget). */
  partsDeadlineMs?: number;
  /** How long a status call waits in all (default 6 s). */
  statusDeadlineMs?: number;
  /** The pause between the patient service list reads after a start (default 3 s). */
  servicesRetryMs?: number;
  /** How long a stopped repair waits for the app to take its end (the audit entry) before the process exits (default 6 s). */
  reportWaitMs?: number;
  /** The lock that keeps repairs and self-heal attempts of separate processes apart (default: .updater/repair.lock); null: none. */
  lock?: RepairLock | null;
  /** How often the move after a hand-over tries while something else runs, and the pause between tries (default 10, 60 s). */
  handoverLayoutRetry?: { tries: number; gapMs: number };
}

/** What the service needs of the music healer (music-heal.ts). */
export interface RepairHealer {
  remount(dir: string, project: string): Promise<RemountResult>;
  /** An attempt runs: no repair, update or module run may start. */
  attempting(): boolean;
  /** Resolves when no attempt runs or waits. */
  settled(): Promise<void>;
}

/** The refusal while the music self-heal attempts (409). */
export const HEALING_ERROR = 'The music share is being connected again. Try again in a minute.';
/** The longest a stopped repair waits for the app to take its end; httpRepairReport gives up after 5 s. */
const REPORT_WAIT_MS = 6000;
/** The longest an automatic start waits for the self-heal to settle (its helper calls have their own limits). */
const HEAL_WAIT_MS = 10 * 60_000;

export interface RefusedStart {
  ok: false;
  status: number;
  error: string;
  /** Which release check refused (422). */
  check?: string;
  selfReplace?: SelfReplaceMarker | null;
}

export class UpdaterService {
  private run: UpdateRun | null = null;
  private active: Promise<UpdateRun> | null = null;
  private readonly verifier: SignatureVerifier;
  private readonly statePath: string;
  private readonly selfReplace: SelfReplaceGate;
  private writing: Promise<void> = Promise.resolve();
  private moduleRun: ModuleRun | null = null;
  private moduleActive: Promise<ModuleRun> | null = null;
  private readonly modulePath: string;
  private repairRun: RepairRun | null = null;
  /** The status repair.json was last written with by this process. */
  private savedStatus: RepairRun['status'] | null = null;
  /** Stale installer repairs already failed here, by id. */
  private readonly failedStale = new Set<string>();
  /** A repair this process stopped (interruptRepair) and the end written for it: the run's own later saves are dropped. */
  private stoppedRepair: { id: string; end: RepairRun | null } | null = null;
  /** The repair of this process: running, or waiting with its watcher. */
  private repair: Repair | null = null;
  private repairActive: Promise<RepairRun> | null = null;
  /** The waiting repair's watcher, until it leaves waiting or is cancelled. */
  private repairWatch: Promise<unknown> | null = null;
  /** followRepairFile's timer. */
  private repairTimer: ReturnType<typeof setInterval> | null = null;
  /** followRepairFile was called: this is the long-running service, which takes over a waiting run another process left. */
  private following = false;
  private readonly repairPath: string;
  private healer: RepairHealer | null = null;
  /** HEAL_WAIT_MS; tests shorten it. */
  private healWaitMs = HEAL_WAIT_MS;
  private partsCache: { at: number; parts: PartState[] } | null = null;
  private partsRefresh: { answered: Map<string, PartState>; done: Promise<void> } | null = null;
  /** load()'s repair of an update that ended with stuck parts. */
  private resuming: Promise<void> | null = null;
  /** The run that is starting (between its checks and its run being under way). */
  private claimed: Claim | null = null;
  /** The cross-process lock a repair's claim took, until beginRepair takes it over. */
  private claimRelease: Release | null = null;
  /** The lock this process's running repair holds, released when it settles. */
  private repairRelease: Release | null = null;
  private readonly lock: RepairLock | null;
  /** Bumped when the parts change: a reading begun before it is not kept. */
  private partsGen = 0;
  /** The last good service list (without the updater), or null before the first read answers. */
  private servicesList: string[] | null = null;
  /** The service list read in flight: one at a time. */
  private servicesRead: Promise<string[] | null> | null = null;
  /** The one read queued after the read in flight (a run ended while it read). */
  private servicesNext: Promise<string[] | null> | null = null;
  /** The host's fstab as last read for musicBoot (null: not read), and when (this.now()). */
  private bootFstab: { at: number; fstab: string | null } | null = null;
  /** The fstab read in flight: one at a time. */
  private bootRead: Promise<string | null> | null = null;
  /** This process took over from the updater that handed over (load()): it owes the one layout move. */
  private tookOver = false;

  constructor(private readonly opts: UpdaterOptions) {
    this.verifier = new SignatureVerifier(opts.appSecret);
    this.statePath = join(opts.installDir, STATE_DIR, 'state.json');
    this.modulePath = join(opts.installDir, STATE_DIR, 'module-run.json');
    this.repairPath = join(opts.installDir, REPAIR_STATE_FILE);
    this.lock = opts.lock === undefined
      ? new RepairLock({ installDir: opts.installDir, ...(opts.now ? { now: () => opts.now!().getTime() } : {}) })
      : opts.lock;
    this.selfReplace = new SelfReplaceGate({
      version: opts.version,
      persist: () => this.writeState(),
      handedOver: async (version) => {
        this.tookOver = true;
        await this.noteHandoverLayout(version, false);
      },
      handoverRunning: async () => {
        const res = await opts.docker(['ps', '-q', '--filter', `label=${HANDOVER_LABEL}`], { timeoutMs: 15_000 });
        return res.code === 0 ? res.stdout.trim() !== '' : null;
      },
      ...(opts.now ? { now: opts.now } : {}),
      ...(opts.log ? { log: opts.log } : {}),
    });
  }

  /**
   * An update, a module run or a repair (not one that waits for the share)
   * is moving containers: the music self-heal waits. That counts a repair
   * the last read of repair.json says runs elsewhere (the installer's
   * one-off), as repairElsewhereOrHere does, without reading the file here.
   */
  moving(): boolean {
    return this.updating() || this.repairRunning() || this.repairElsewhere();
  }

  /** An update or a module run is moving containers (never a repair: a repair's own remount must not be refused). */
  updating(): boolean {
    return this.active !== null || this.moduleActive !== null || this.claimed === 'update' || this.claimed === 'module';
  }

  private repairRunning(): boolean {
    return this.repair?.run.status === 'running' || this.claimed === 'repair';
  }

  /** The parts changed (a run started or ended): the next status reads them again. */
  private partsChanged(): void {
    this.partsCache = null;
    this.partsGen++;
  }

  /** A run ended: the parts read again, and the service list (it may have changed) in the background. */
  private runEnded(): void {
    this.partsChanged();
    void this.rereadServices();
  }

  /**
   * A service list read that begins after now: a read in flight began
   * before the change, so exactly one more read is queued after it.
   */
  private rereadServices(): Promise<string[] | null> {
    if (!this.servicesRead) return this.readServices();
    this.servicesNext ??= this.servicesRead.then(() => {
      this.servicesNext = null;
      return this.readServices();
    });
    return this.servicesNext;
  }

  private now(): Date {
    return (this.opts.now ?? (() => new Date()))();
  }

  /** The music healer, for a repair's remount (main.ts: the healer's busy reads moving(), so it comes after the service). */
  attachHealer(healer: RepairHealer): void {
    this.healer = healer;
  }

  /** Loads the last runs; a run still marked running was cut off (the updater or the host restarted). */
  async load(): Promise<void> {
    void this.readServices();
    await this.loadModuleRun();
    await this.loadUpdateRun();
    await this.loadRepair();
    this.resuming = this.finishStuckUpdate().catch(() => undefined).finally(() => { this.resuming = null; });
  }

  private async loadUpdateRun(): Promise<void> {
    const text = await readText(this.statePath);
    if (!text) return;
    try {
      const { run, marker } = parseState(text);
      if (!run) return;
      this.run = run;
      await this.selfReplace.adopt(marker);
      if (run.status === 'running') {
        const step = run.steps.find((s) => s.status === 'running');
        run.status = 'interrupted';
        run.finishedAt = new Date().toISOString();
        run.reason = `The updater stopped during "${step?.label ?? 'the update'}". Check TAGAVE_VERSION in .env and run docker compose up -d in the install folder; ${run.backup
          ? `the backup from before the update is ${run.backup}`
          : `if the new version changed the database, the backup to restore is the first one under Before update in Settings › Backups taken after ${run.startedAt}`}.`;
        run.progress = null;
        run.stall = null;
        if (step) step.status = 'failed';
        run.log.push({ at: run.finishedAt, level: 'error', message: 'the updater restarted in the middle of this update' });
        await this.save(run);
      }
      this.run = run;
    } catch {
      /* an unreadable state file is ignored */
    }
  }

  /** repair.json: a running repair was cut off and fails; a waiting one gets its watcher back. */
  private async loadRepair(): Promise<void> {
    const text = await readText(this.repairPath);
    if (!text) return;
    let run: RepairRun;
    try {
      run = JSON.parse(text) as RepairRun;
    } catch {
      return; /* an unreadable state file is ignored */
    }
    this.repairRun = run;
    if (run.status === 'running') {
      // The installer's one-off may still run it (R29); a repair of an updater was cut off.
      if (run.trigger === 'installer') return this.failStale(run);
      await this.failRepair(run, RESTARTED_DURING_REPAIR, 'the updater restarted in the middle of this repair');
    } else if (run.status === 'waiting') {
      this.watchRepair(new Repair(this.repairDeps(), run));
    }
  }

  /** An installer's repair marked running for over an hour has stopped (R29). */
  private async failStale(run: RepairRun): Promise<void> {
    if (run.trigger !== 'installer' || run.status !== 'running' || this.now().getTime() - Date.parse(run.startedAt) < ELSEWHERE_MS) return;
    // Two reads at once both see it: it fails (and is reported) once.
    if (this.failedStale.has(run.id)) return;
    this.failedStale.add(run.id);
    await this.failRepair(run, STOPPED_REPAIR, 'this repair stopped without an end');
  }

  /**
   * Ends a repair that no process runs any more: failed, saved, and told to
   * the app (its audit end row). Resolves once saved; `told` resolves once the
   * app took the end or gave up. A status call that found the run stale never
   * waits on the app; a process about to exit (interruptRepair) does.
   */
  private async failRepair(run: RepairRun, reason: string, message: string): Promise<{ told: Promise<void> }> {
    const at = this.now().toISOString();
    const step = run.steps.find((s) => s.status === 'running');
    if (step) Object.assign(step, { status: 'failed', finishedAt: at });
    Object.assign(run, { status: 'failed', finishedAt: at, reason, headline: reason, progress: null, stall: null });
    run.log.push({ at, level: 'error', message });
    await this.saveRepair(run).catch(() => undefined);
    let told: Promise<void>;
    try {
      told = Promise.resolve(this.opts.report?.({ status: 'failed', cause: null })).catch(() => undefined);
    } catch {
      /* the run on disk says how it ended */
      told = Promise.resolve();
    }
    return { told };
  }

  /**
   * After an updater start, an update that ended with stuck parts gets a
   * repair: held (the parts wait for the music share), or rollback_failed
   * with `stuck` parts (nothing starts them again after a host restart).
   *
   * Decision 3 (automatic repair only for the music cases) is extended by one
   * case: after an updater start, a repair finishes an update that was
   * interrupted by stuck parts (held, or rollback_failed with stuck parts).
   * It runs the same safe steps as the Repair button (start the parts, and
   * one recreate or restart where the cause table allows it); it never
   * changes a version, a setting or the database.
   *
   * A rollback_failed run without `stuck` never gets one: its files or
   * database may be half restored. Once per interrupted update: none when a
   * repair started at or after the update ended (web's showRepair rule), as
   * the update keeps its status until the next one. Only when a part is down
   * (stopped, missing or stuck): one still starting (a health check at boot)
   * is not.
   */
  private async finishStuckUpdate(): Promise<void> {
    const run = this.run;
    if (!run) return;
    const stuck = (run.status === 'held' && (run.held?.parts.length ?? 0) > 0) || (run.status === 'rollback_failed' && (run.stuck?.length ?? 0) > 0);
    if (!stuck) return;
    const last = this.repairRun;
    if (last?.status === 'running' || last?.status === 'waiting') return;
    if (last && run.finishedAt && Date.parse(last.startedAt) >= Date.parse(run.finishedAt)) return;
    // After a reboot nobody can press Repair: a slow list is read again, not skipped.
    const services = await this.servicesPatiently();
    if (services.length === 0) {
      this.warn('the update ended with stuck parts, but the list of parts could not be read, so no repair started', { runId: run.id });
      return;
    }
    const parts = await readParts(this.opts.docker, services);
    if (!parts.some((p) => p.state === 'stopped' || p.state === 'missing' || p.state === 'stuck')) return;
    const started = await this.startRepairAfterHeal();
    if (!started.ok) this.warn(`the update ended with stuck parts, and no repair could start: ${started.error}`, { runId: run.id });
  }

  private async loadModuleRun(): Promise<void> {
    const text = await readText(this.modulePath);
    if (!text) return;
    try {
      const run = JSON.parse(text) as ModuleRun;
      if (run.status === 'running') {
        const step = run.steps.find((s) => s.status === 'running');
        run.status = 'interrupted';
        run.finishedAt = new Date().toISOString();
        run.reason = `The updater stopped during "${step?.label ?? 'the module run'}". Check COMPOSE_PROFILES in .env (.env.bak is the file from before) and run docker compose up -d --remove-orphans in the install folder.`;
        if (step) step.status = 'failed';
        run.log.push({ at: run.finishedAt, level: 'error', message: 'the updater restarted in the middle of this run' });
        await this.saveModuleRun(run);
      }
      this.moduleRun = run;
    } catch {
      /* an unreadable state file is ignored */
    }
  }

  /**
   * The module run on disk, when none runs in this process: install-tagave.sh
   * enable-module runs the same state machine in a one-off container and
   * writes the same file.
   */
  private async refreshModuleRun(): Promise<void> {
    if (this.moduleActive) return;
    const text = await readText(this.modulePath);
    if (!text) return;
    try {
      this.moduleRun = JSON.parse(text) as ModuleRun;
    } catch {
      /* keep what we have */
    }
  }

  private async saveModuleRun(run: ModuleRun): Promise<void> {
    this.moduleRun = run;
    await mkdirKeepingOwner(join(this.opts.installDir, STATE_DIR), 0o700);
    await writeFileAtomic(this.modulePath, `${JSON.stringify(run, null, 2)}\n`, false);
  }

  // -- releases ------------------------------------------------------------------

  private async env(): Promise<string> {
    return (await readText(join(this.opts.installDir, '.env'))) ?? '';
  }

  /** This computer's platform: DOCKER_DEFAULT_PLATFORM from .env, else Docker's architecture. */
  async platform(): Promise<string> {
    return platformOf(this.opts.arch ?? dockerArch(), envGet(await this.env(), 'DOCKER_DEFAULT_PLATFORM'));
  }

  private async floor(): Promise<string | null> {
    return (await readText(join(this.opts.installDir, RELEASE_FLOOR_FILE)))?.trim() || null;
  }

  /** Verifies a manifest for `version`, not older than what runs here nor than any release run here before. */
  async verify(version: string, manifest: string, signature: string | null | undefined, running: string | null): Promise<VerifiedRelease> {
    return verifyRelease(manifest, signature, this.opts.keys, { version, running, floor: await this.floor() });
  }

  /** The signed manifest of the release that runs here (kept next to the install), checked; or why there is none. */
  async currentRelease(): Promise<{ verified: VerifiedRelease; problem: null } | { verified: null; problem: string }> {
    const version = envGet(await this.env(), 'TAGAVE_VERSION');
    if (!version) return { verified: null, problem: 'TAGAVE_VERSION is not set in .env' };
    const text = await readText(join(this.opts.installDir, MANIFEST_FILE));
    if (text === null) return { verified: null, problem: `the signed manifest of ${version} is not here yet` };
    try {
      return { verified: await this.verify(version, text, await readText(join(this.opts.installDir, SIGNATURE_FILE)), version), problem: null };
    } catch (err) {
      return { verified: null, problem: (err as Error).message };
    }
  }

  /** Takes the signed manifest of the running release (POST /v1/release). */
  async acceptRelease(manifest: string, signature: string): Promise<{ ok: true } | RefusedStart> {
    const version = envGet(await this.env(), 'TAGAVE_VERSION');
    if (!version) return { ok: false, status: 409, error: 'TAGAVE_VERSION is not set in .env' };
    try {
      const v = await this.verify(version, manifest, signature, version);
      await writeFileKeepingOwner(join(this.opts.installDir, MANIFEST_FILE), v.text, { fallbackMode: 0o644 });
      await writeFileKeepingOwner(join(this.opts.installDir, SIGNATURE_FILE), v.signature, { fallbackMode: 0o644 });
      return { ok: true };
    } catch (err) {
      if (err instanceof ReleaseRefused) return { ok: false, status: 422, error: err.message, check: err.check };
      throw err;
    }
  }

  /**
   * Refuses a start while anything else runs, else claims the one run slot
   * for `kind`. The claim is taken after the last await, so two starts can
   * never both pass; the caller releases it once its run is under way (or
   * refused).
   */
  private async claim(kind: Claim): Promise<RefusedStart | null> {
    if (this.claimed) return this.claimedRefusal(this.claimed);
    const restarting = await this.selfReplace.refusal();
    if (restarting) return { ok: false, status: 409, error: restarting, selfReplace: this.selfReplace.current };
    if (this.active) return { ok: false, status: 409, error: 'an update is already running' };
    await this.refreshModuleRun();
    const elsewhere = !this.moduleActive && this.moduleRun?.status === 'running' && this.now().getTime() - Date.parse(this.moduleRun.startedAt) < 60 * 60_000;
    if (this.moduleActive || elsewhere) return this.claimedRefusal('module');
    if (await this.repairElsewhereOrHere()) return this.claimedRefusal('repair');
    // A repair also takes the lock other processes see (the installer's
    // one-off, or the service): held there, this one is refused, not failed.
    let release: Release | null = null;
    if (kind === 'repair') {
      const got = await this.lockParts('repair');
      if (got === 'repair') return this.claimedRefusal('repair');
      if (got === 'heal') return { ok: false, status: 409, error: HEALING_ERROR };
      release = got;
    }
    // No await from here on: the checks and the claim are one step. The
    // healer sets attempting() with no await after its busy() (moving())
    // read either, so of a start and a self-heal attempt exactly one goes.
    const refused = this.claimed ? this.claimedRefusal(this.claimed)
      : this.healer?.attempting() ? { ok: false as const, status: 409, error: HEALING_ERROR }
      : null;
    if (refused) {
      // Let go before answering: a caller that tries again at once finds it free.
      await release?.();
      return refused;
    }
    this.claimed = kind;
    this.claimRelease = release;
    return null;
  }

  /**
   * Takes the cross-process lock (repair-lock.ts) for `holder`: its release,
   * or who holds it now. Without a lock, or when it cannot be written here,
   * a release that does nothing (the in-process checks still apply).
   */
  async lockParts(holder: LockHolder): Promise<Release | LockHolder> {
    if (!this.lock) return async () => undefined;
    const got = await this.lock.acquire(holder);
    if (got.ok) return got.release;
    return got.holder ?? (async () => undefined);
  }

  private claimedRefusal(kind: Claim): RefusedStart {
    if (kind === 'update') return { ok: false, status: 409, error: 'an update is already running' };
    if (kind === 'repair') return { ok: false, status: 409, error: 'a repair is running' };
    return { ok: false, status: 409, error: `${this.moduleRun?.moduleName ?? 'a module'} is being turned ${this.moduleRun?.action === 'disable' ? 'off' : 'on'}` };
  }

  /** Runs `start` under a claim on the run slot, released once it returns. */
  private async withClaim<T>(kind: Claim, start: () => Promise<T>): Promise<T | RefusedStart> {
    const refused = await this.claim(kind);
    if (refused) return refused;
    try {
      return await start();
    } finally {
      this.claimed = null;
      // A start that did not take the lock over (it threw) lets it go.
      const left = this.claimRelease;
      this.claimRelease = null;
      await left?.();
    }
  }

  // -- repair ----------------------------------------------------------------------

  /** A repair runs in this process, or repair.json says one runs elsewhere (the installer's one-off, under 1 h old). */
  private async repairElsewhereOrHere(): Promise<boolean> {
    if (this.repairRunning()) return true;
    await this.refreshRepair();
    return this.repairElsewhere();
  }

  /** The known repair.json run is another process's, running and under 1 h old. */
  private repairElsewhere(): boolean {
    const r = this.repairRun;
    return r?.status === 'running' && r.id !== this.repair?.run.id && this.now().getTime() - Date.parse(r.startedAt) < ELSEWHERE_MS;
  }

  /**
   * repair.json, unless this process starts or runs a repair: the installer's
   * one-off writes the same file. A waiting watcher here yields to another
   * run named there, and in the long-running service (followRepairFile) a
   * waiting run of another process gets this process's watcher.
   */
  private async refreshRepair(): Promise<void> {
    if (this.ownRepair()) return;
    const known = this.repairRun;
    const text = await readText(this.repairPath);
    // A repair started here while it read (or another read landed first): the file is not newer.
    if (!text || this.ownRepair() || this.repairRun !== known) return;
    let run: RepairRun;
    try {
      run = JSON.parse(text) as RepairRun;
    } catch {
      return; /* keep what we have */
    }
    // Our own run read back is an older save of it (a read in the gap of its last write): ours is newer.
    if (run.id === this.repair?.run.id) return;
    // Another process started a repair: the new run is current first, so the old watcher's late save is ignored.
    this.repairRun = run;
    if (this.repair?.run.status === 'waiting') {
      this.repair.cancel();
      this.repair = null;
    }
    if (run.status === 'waiting' && this.following) this.watchRepair(new Repair(this.repairDeps(), run));
    else await this.failStale(run);
  }

  /**
   * Before a waiting run's save: another process may have started a repair
   * over repair.json since (Repair in Settings while cli.js waits, or the
   * installer while the service waits). Then this watcher stops, the file's
   * run is current (taken over here per followRepairFile), and nothing is
   * written. True when the save must not land.
   */
  private async replacedOnDisk(run: RepairRun): Promise<boolean> {
    let file: RepairRun | null;
    try {
      const text = await readText(this.repairPath);
      file = text ? (JSON.parse(text) as RepairRun) : null;
    } catch {
      return false; /* unreadable: the save puts it right */
    }
    if (!file || file.id === run.id) return false;
    // A repair started here while it read: that one owns the file.
    if (this.claimed === 'repair' || (this.repairRun && this.repairRun.id !== run.id)) return true;
    this.repairRun = file;
    if (this.repair?.run.id === run.id) {
      this.repair.cancel();
      this.repair = null;
    }
    if (file.status === 'waiting' && this.following) this.watchRepair(new Repair(this.repairDeps(), file));
    return true;
  }

  /** This process starts or runs a repair: repair.json is ours, never read back over it. */
  private ownRepair(): boolean {
    return this.claimed === 'repair' || this.repair?.run.status === 'running';
  }

  /**
   * Reads repair.json every `everyMs` (main.ts, after load()): a repair the
   * installer's one-off left waiting gets this process's watcher even when
   * no status call comes for hours. stop() ends it.
   */
  followRepairFile(everyMs = REPAIR_FILE_POLL_MS): void {
    this.following = true;
    if (this.repairTimer) return;
    this.repairTimer = setInterval(() => void this.refreshRepair().catch(() => undefined), everyMs);
    this.repairTimer.unref();
  }

  /**
   * Waits up to `ms` for this process's waiting repair to finish (cli.js
   * repair --wait). The run stays waiting when the time runs out.
   */
  async waitForRepair(ms: number): Promise<void> {
    const watching = this.repairWatch;
    if (!watching) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); });
    await Promise.race([watching, deadline]).finally(() => clearTimeout(timer));
  }

  /**
   * cli.js repair on SIGINT or SIGTERM: this process's running repair ends
   * failed ("The repair stopped. Press Repair again."), saved before it
   * resolves, so repair.json never says running for the hour R29 waits. A
   * waiting repair stays waiting (another start or the service resumes it).
   * It resolves once the app took the end (the audit entry) or reportWaitMs
   * passed: the process exits right after, and a report still in flight
   * would be lost. A run that had just ended gets its own report the same time.
   */
  async interruptRepair(): Promise<void> {
    const repair = this.repair;
    if (repair && repair.run.status !== 'running') return this.within(repair.reported());
    if (repair?.run.status !== 'running') return;
    const stopped: { id: string; end: RepairRun | null } = { id: repair.run.id, end: null };
    this.stoppedRepair = stopped;
    repair.cancel();
    // Its saves in flight land first; the end below is the last write.
    await repair.saved().catch(() => undefined);
    // A copy: the run object goes on changing until the process exits.
    stopped.end = structuredClone(repair.run);
    const { told } = await this.failRepair(stopped.end, STOPPED_REPAIR, 'the repair was stopped before it ended');
    await this.within(told);
    // Last, right before the process exits: the stopped run sends no more Docker calls,
    // and the next start need not wait for the lock to go stale. A watcher's resume holds its own.
    await this.releaseRepair(this.repairRelease);
    await repair.releaseHeld();
  }

  private async releaseRepair(release: Release | null): Promise<void> {
    if (this.repairRelease === release) this.repairRelease = null;
    await release?.().catch(() => undefined);
  }

  /** `p`, or reportWaitMs, whichever comes first. */
  private async within(p: Promise<void>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<void>((resolve) => { timer = setTimeout(resolve, this.opts.reportWaitMs ?? REPORT_WAIT_MS); });
    await Promise.race([p.catch(() => undefined), limit]).finally(() => clearTimeout(timer));
  }

  /** Resolves when this process's repair has written every save it asked for (cli.js, before it exits). */
  async repairSaved(): Promise<void> {
    await this.repair?.saved();
  }

  private repairDeps(): RepairDeps {
    const c = this.opts.config;
    return {
      installDir: this.opts.installDir,
      docker: this.opts.docker,
      app: this.opts.app,
      music: this.opts.music ?? null,
      ...(this.opts.musicUnmounted ? { musicUnmounted: this.opts.musicUnmounted } : {}),
      ...(this.opts.layoutImage ? { layoutImage: this.opts.layoutImage } : {}),
      healer: this.healer,
      ...(this.opts.report ? { report: this.opts.report } : {}),
      save: (r) => this.saveRepair(r),
      config: { ...DEFAULT_REPAIR_CONFIG, healthTimeoutMs: c.healthTimeoutMs, pollMs: c.pollMs, ...this.opts.repairConfig },
      ...(this.opts.now ? { now: this.opts.now } : {}),
      // Read only by a waiting repair's watcher: it does not resume while a self-heal attempt restarts the same parts.
      busy: () => this.moving() || !!this.healer?.attempting(),
      // ... nor while another process repairs or heals: each resume holds the lock.
      lockParts: async () => {
        const got = await this.lockParts('repair');
        return typeof got === 'function' ? got : null;
      },
    };
  }

  private async saveRepair(run: RepairRun): Promise<void> {
    // A run the owner replaced (Repair pressed while it waited) writes nothing more.
    if (this.repairRun && run.id !== this.repairRun.id) return;
    // A stopped run: only its end (interruptRepair's) is written.
    if (this.stoppedRepair?.id === run.id && run !== this.stoppedRepair.end) return;
    // A running or ending save is the claim's to protect; a waiting one checks the file first.
    if (run.status === 'waiting') {
      if (await this.replacedOnDisk(run)) return;
      // A repair started here while it read (the file may still name this run): that one owns the file now.
      if (this.claimed === 'repair' || (this.repairRun && this.repairRun.id !== run.id)) return;
    }
    // running, waiting and the end move parts: the next status reads them again.
    if (this.savedStatus !== run.status) this.partsChanged();
    this.savedStatus = run.status;
    this.repairRun = run;
    await this.writeRepair(run);
  }

  private async writeRepair(run: RepairRun): Promise<void> {
    await mkdirKeepingOwner(join(this.opts.installDir, STATE_DIR), 0o700);
    await writeFileAtomic(this.repairPath, `${JSON.stringify(run, null, 2)}\n`, false);
  }

  /** A waiting repair's watcher: it finishes the run when the share answers. */
  private watchRepair(repair: Repair): void {
    this.repair = repair;
    this.repairRun = repair.run;
    this.savedStatus = repair.run.status;
    const watching: Promise<unknown> = repair.watch().catch(() => undefined).finally(() => {
      if (this.repairWatch === watching) this.repairWatch = null;
      this.runEnded();
    });
    this.repairWatch = watching;
  }

  /**
   * Starts a repair in the background (POST /v1/repair, a held update, or an
   * update left with stuck parts after a restart). A repair that waits for
   * the share is cancelled and a fresh one starts at check.
   */
  startRepair(trigger: RepairRun['trigger']): Promise<{ ok: true; run: RepairRun } | RefusedStart> {
    return this.withClaim('repair', () => this.beginRepair(trigger));
  }

  private async beginRepair(trigger: RepairRun['trigger']): Promise<{ ok: true; run: RepairRun } | RefusedStart> {
    const run = newRepairRun(randomUUID(), trigger, this.now());
    const before = this.repairRun;
    const release = this.claimRelease;
    this.claimRelease = null;
    // The new run is the current one first, so a waiting watcher's late save is ignored.
    this.repairRun = run;
    try {
      await this.writeRepair(run);
    } catch (err) {
      // Nothing started: the old run (a waiting one goes on waiting) stays current.
      this.repairRun = before;
      await release?.();
      return { ok: false, status: 500, error: `the repair could not be saved: ${(err as Error).message}` };
    }
    // Pressed again while it waits: the watcher stops and the new run starts at check.
    if (this.repair?.run.status === 'waiting') this.repair.cancel();
    const repair = new Repair(this.repairDeps(), run);
    this.repair = repair;
    this.savedStatus = run.status;
    this.partsChanged();
    this.repairRelease = release;
    this.repairActive = repair.execute()
      .then(async (r) => {
        if (r.status === 'waiting' && this.repair === repair) this.watchRepair(repair);
        // Settled: the lock goes (a waiting run's watcher takes it again for each resume).
        await this.releaseRepair(release);
        return r;
      })
      .finally(() => {
        this.repairActive = null;
        this.runEnded();
      });
    return { ok: true, run };
  }

  /**
   * The updater is stopping: a waiting repair's watcher stops and the run
   * stays waiting in repair.json (the next start resumes it). A running
   * repair is left to end on its own.
   */
  stop(): void {
    if (this.repairTimer) clearInterval(this.repairTimer);
    this.repairTimer = null;
    if (this.repair?.run.status === 'waiting') this.repair.cancel();
  }

  // -- the music share layout after a hand-over -----------------------------------

  /**
   * The one-time move to the parent music layout (music-layout.ts), once
   * after this updater took over from the one that ran the update (owner
   * decision R5: the update to 0.39.0 runs the 0.38 updater, so this is
   * where 0.39.0 moves eligible installs). main.ts calls it in the
   * background once the server listens. It runs when load() found the
   * marker of a finished hand-over to this version, or when
   * HANDOVER_LAYOUT_FILE still says the move is owed for it (this process
   * died between clearing the marker and the move); never a second time.
   *
   * It runs under a repair's claim (the run slot and .updater/repair.lock,
   * as cli.js music-layout --apply), so never during an update, a module
   * run, a repair or a self-heal attempt: while one runs it tries again,
   * up to 10 times a minute apart, then gives up with one line (the next
   * Repair or update tries the move anyway). The move is moveLayout, as
   * Repair and cli.js run it; only the music parts start, through Parts
   * with the music prober. Its lines go to the finished update's run log
   * (state.json), or to the console when that run is not the one that
   * brought this version. Never throws.
   */
  async layoutAfterHandover(): Promise<void> {
    try {
      const version = this.opts.version;
      const noted = await this.readHandoverLayout();
      const owed = noted && noted.version === version ? !noted.done : this.tookOver;
      if (!owed) return;
      // No image: no move, as for Repair.
      if (this.opts.layoutImage) await this.moveAfterHandover();
      await this.noteHandoverLayout(version, true);
    } catch (err) {
      this.layoutLog('warn', `the music share layout was not changed: ${(err as Error)?.message ?? String(err)}`);
    }
    await this.writing;
  }

  private async moveAfterHandover(): Promise<void> {
    const { tries, gapMs } = this.opts.handoverLayoutRetry ?? HANDOVER_LAYOUT_RETRY;
    for (let i = 0; i < tries; i++) {
      if (i > 0) await new Promise<void>((resolve) => { setTimeout(resolve, gapMs).unref?.(); });
      // load()'s repair of an update left with stuck parts goes first.
      await this.resuming;
      const res = await this.withClaim('repair', () => this.moveLayoutNow());
      if (res === true) return;
    }
    this.layoutLog('warn', HANDOVER_LAYOUT_SKIPPED);
  }

  /** The move itself, under the claim. A throw is logged here, as Repair logs it. */
  private async moveLayoutNow(): Promise<true> {
    const log = (level: 'info' | 'warn', message: string) => this.layoutLog(level, message);
    const envPath = join(this.opts.installDir, '.env');
    try {
      await moveLayout({
        installDir: this.opts.installDir,
        docker: this.opts.docker,
        image: this.opts.layoutImage!,
        log,
        start: async (services) => {
          const parts = new Parts({ docker: this.opts.docker, music: this.opts.music ?? null, now: () => this.now().getTime(), log: (l, m) => log(l === 'error' ? 'warn' : l, m) });
          const res = await parts.startParts(services);
          for (const p of res.stuck) log('warn', `${partName(p.service)} did not start on the new settings`);
        },
      });
    } catch (err) {
      const why = (err as Error)?.message ?? String(err);
      const after = (await readText(envPath).catch(() => null)) ?? '';
      if (hasParentLayout(after)) log('warn', `.env has the parent layout's settings, but the music parts were not started on them: ${why}`);
      else log('warn', `the music share layout was not changed: ${why}`);
    } finally {
      this.partsChanged();
    }
    return true;
  }

  /**
   * One line of the move: into the run that brought this version (finished,
   * and no update runs now) as the update's own lines are, else the console.
   */
  private layoutLog(level: 'info' | 'warn', message: string): void {
    const run = this.run;
    if (run && run.target === this.opts.version && run.status !== 'running' && !this.active) {
      run.log.push({ at: this.now().toISOString(), level, message });
      void this.save(run).catch(() => undefined);
      return;
    }
    if (level === 'warn') this.warn(message, {});
    else if (this.opts.log) this.opts.log('info', message, {});
    else console.log(JSON.stringify({ msg: message, level }));
  }

  private async readHandoverLayout(): Promise<{ version: string; done: boolean } | null> {
    try {
      const text = await readText(join(this.opts.installDir, HANDOVER_LAYOUT_FILE));
      const raw = text ? (JSON.parse(text) as Record<string, unknown>) : null;
      return raw && typeof raw['version'] === 'string' ? { version: raw['version'], done: raw['done'] === true } : null;
    } catch {
      return null;
    }
  }

  private async noteHandoverLayout(version: string, done: boolean): Promise<void> {
    await mkdirKeepingOwner(join(this.opts.installDir, STATE_DIR), 0o700);
    await writeFileAtomic(join(this.opts.installDir, HANDOVER_LAYOUT_FILE), `${JSON.stringify({ version, done, at: this.now().toISOString() }, null, 2)}\n`, false);
  }

  /** An update that ended held hands its stuck parts to a repair (Decision 3: the music case). Never throws. */
  private async afterUpdate(run: UpdateRun): Promise<void> {
    if (run.status !== 'held') return;
    try {
      const started = await this.startRepairAfterHeal();
      if (!started.ok) this.warn(`the held update could not hand its parts to a repair: ${started.error}`, { runId: run.id });
    } catch (err) {
      this.warn(`the held update could not hand its parts to a repair: ${(err as Error).message}`, { runId: run.id });
    }
  }

  /**
   * An update's own repair (held, or stuck after a restart): it waits for a
   * self-heal attempt to settle first, and once more when a new attempt
   * refuses it, then tries once more.
   */
  private async startRepairAfterHeal(): Promise<{ ok: true; run: RepairRun } | RefusedStart> {
    await this.healSettled();
    const started = await this.startRepair('update');
    if (started.ok || started.error !== HEALING_ERROR) return started;
    await this.healSettled();
    return this.startRepair('update');
  }

  /** The healer's settled(), never longer than healWaitMs. */
  private async healSettled(): Promise<void> {
    if (!this.healer) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<void>((resolve) => { timer = setTimeout(resolve, this.healWaitMs); });
    try {
      await Promise.race([this.healer.settled().catch(() => undefined), limit]);
    } finally {
      clearTimeout(timer);
    }
  }

  private warn(message: string, fields: Record<string, unknown>): void {
    if (this.opts.log) this.opts.log('warn', message, fields);
    else console.warn(JSON.stringify({ msg: message, level: 'warn', ...fields }));
  }

  // -- parts -----------------------------------------------------------------------

  /** The service list: the last good one, else the read (a failed read gives none). */
  private async services(): Promise<string[]> {
    return this.servicesList ?? (await this.readServices()) ?? [];
  }

  /**
   * The service list for a caller nobody waits on: the last good list, else
   * the read in flight, else up to SERVICES_PATIENT_TRIES reads with the
   * longer limit, a few seconds apart. None after that gives none.
   */
  private async servicesPatiently(): Promise<string[]> {
    if (this.servicesList?.length) return this.servicesList;
    const inFlight = await this.servicesRead;
    if (inFlight?.length) return inFlight;
    for (let tries = 1; ; tries++) {
      const list = this.servicesList?.length ? this.servicesList : await this.readServices(SERVICES_PATIENT_READ_MS);
      if (list?.length) return list;
      if (tries >= SERVICES_PATIENT_TRIES) return [];
      await new Promise((resolve) => setTimeout(resolve, this.opts.servicesRetryMs ?? SERVICES_RETRY_MS));
    }
  }

  /**
   * Reads the service list (without the updater); a second call while one
   * reads gets the same read. A good answer is kept; a failed one (null)
   * keeps the last good list.
   */
  private readServices(timeoutMs = SERVICES_READ_MS): Promise<string[] | null> {
    if (this.servicesRead) return this.servicesRead;
    const read = this.opts.docker(['compose', 'config', '--services'], { timeoutMs })
      .then((svc) => (svc.code === 0 ? svc.stdout.split('\n').map((s) => s.trim()).filter((s) => s && s !== 'updater') : null), () => null)
      .then((list) => {
        if (!list) return null;
        // Another list: a parts reading kept for the old one is not served.
        if (this.servicesList && this.servicesList.join('\n') !== list.join('\n')) this.partsChanged();
        this.servicesList = list;
        return list;
      })
      .finally(() => { if (this.servicesRead === read) this.servicesRead = null; });
    this.servicesRead = read;
    return read;
  }

  /**
   * Each part's state for /v1/status: kept 10 s; a new reading runs in the
   * background, and a status call waits for it at most partsDeadlineMs. A
   * part with no answer by then reads stuck.
   */
  private async partStates(services: string[], deadlineMs: number): Promise<PartState[]> {
    const cached = this.partsCache;
    if (cached && Date.now() - cached.at < PARTS_CACHE_MS) return cached.parts;
    if (!this.partsRefresh) {
      const gen = this.partsGen;
      const answered = new Map<string, PartState>();
      const done = Promise.all(services.map(async (service) => {
        const [p] = await readParts(this.opts.docker, [service]);
        answered.set(service, p ?? { service, state: 'stuck', health: null });
      }))
        .then(() => {
          // Parts changed while it read: the reading is not kept.
          if (gen === this.partsGen) this.partsCache = { at: Date.now(), parts: services.map((s) => answered.get(s)!) };
        })
        .finally(() => { this.partsRefresh = null; });
      this.partsRefresh = { answered, done };
    }
    const { answered, done } = this.partsRefresh;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, deadlineMs);
      (timer as { unref?: () => void }).unref?.();
    });
    await Promise.race([done, deadline]).finally(() => clearTimeout(timer));
    return services.map((service) => answered.get(service) ?? { service, state: 'stuck', health: null });
  }

  // -- modules ---------------------------------------------------------------------

  async modules(): Promise<UpdaterModules> {
    await this.refreshModuleRun();
    const version = envGet(await this.env(), 'TAGAVE_VERSION');
    const current = await this.currentRelease();
    const modules = current.verified
      ? await moduleStatuses({ installDir: this.opts.installDir, release: current.verified, platform: await this.platform(), run: this.moduleRun, active: this.moduleActive !== null })
      : [];
    return { version, verified: current.verified !== null, problem: current.problem, modules, run: this.moduleRun };
  }

  startModule(id: string, action: 'enable' | 'disable', deleteData: boolean, deleteHistory = false): Promise<{ ok: true; run: ModuleRun } | RefusedStart> {
    return this.withClaim('module', () => this.beginModule(id, action, deleteData, deleteHistory));
  }

  private async beginModule(id: string, action: 'enable' | 'disable', deleteData: boolean, deleteHistory: boolean): Promise<{ ok: true; run: ModuleRun } | RefusedStart> {
    const current = await this.currentRelease();
    if (!current.verified) return { ok: false, status: 422, error: `modules come only from the signed catalogue of the release that runs here, and ${current.problem}`, check: 'manifest' };
    const entry = current.verified.manifest.modules.find((m) => m.id === id);
    if (!entry) return { ok: false, status: 404, error: `${id} is not in the signed catalogue of ${current.verified.manifest.version}; only official modules can be installed` };
    const run = newModuleRun(randomUUID(), entry, action, current.verified.manifest.version, deleteData, (this.opts.now ?? (() => new Date()))(), deleteHistory);
    const c = this.opts.config;
    const op = new ModuleOperation(
      {
        installDir: this.opts.installDir,
        docker: this.opts.docker,
        app: this.opts.app,
        config: {
          minFreeBytes: c.minFreeBytes,
          healthTimeoutMs: c.healthTimeoutMs,
          moduleHealthTimeoutMs: c.playerHealthTimeoutMs,
          pollMs: c.pollMs,
          commandTimeoutMs: c.commandTimeoutMs,
          ...this.opts.moduleConfig,
        },
        release: current.verified,
        platform: await this.platform(),
        save: (r) => this.saveModuleRun(r),
      },
      run,
    );
    await this.saveModuleRun(run);
    this.partsChanged();
    this.moduleActive = op.execute().finally(() => { this.moduleActive = null; this.runEnded(); });
    return { ok: true, run };
  }

  private async save(run: UpdateRun): Promise<void> {
    this.run = run;
    await this.writeState();
  }

  /** state.json: the run, and the self-replace marker while one is pending. One write at a time. */
  private writeState(): Promise<void> {
    const write = async () => {
      if (!this.run) return;
      await mkdirKeepingOwner(join(this.opts.installDir, STATE_DIR), 0o700);
      await writeFileAtomic(this.statePath, serializeState(this.run, this.selfReplace.current), false);
    };
    const next = this.writing.then(write, write);
    this.writing = next.catch(() => undefined);
    return next;
  }

  /**
   * GET /v1/status. One budget (statusDeadlineMs) for all it waits on: the
   * service list (cached; read only when none is known yet), the parts and
   * the hand-over check. What is late is left to finish in the background.
   */
  async status(): Promise<UpdaterStatus> {
    const end = Date.now() + (this.opts.statusDeadlineMs ?? STATUS_DEADLINE_MS);
    const env = (await readText(join(this.opts.installDir, '.env'))) ?? '';
    // Read alongside the rest, within the same budget.
    const musicBoot = this.musicBoot(env, end);
    let services = this.servicesList;
    if (!services) {
      const list = await beforeEnd(end, this.readServices(), () => null);
      // Too little time left to read its parts: late for this call; the cache has it for the next.
      services = list && end - Date.now() >= LATE_LIST_MS ? list : [];
    }
    await this.refreshRepair();
    const marker = this.selfReplace.status();
    // No services known (yet): no parts, and nothing kept that hides them once the list comes.
    const parts = services.length === 0
      ? Promise.resolve([])
      : this.partStates(services, Math.min(this.opts.partsDeadlineMs ?? PARTS_DEADLINE_MS, Math.max(0, end - Date.now())));
    return {
      version: this.opts.version,
      configuredVersion: envGet(env, 'TAGAVE_VERSION'),
      role: envGet(env, 'TAGAVE_ROLE'),
      services,
      run: this.run,
      // A hand-over check still waiting on Docker: the marker known so far.
      selfReplace: await beforeEnd(end, marker, () => this.selfReplace.shown()),
      parts: await parts,
      repair: this.repairRun,
      musicBoot: await musicBoot,
    };
  }

  /**
   * The status's musicBoot: the codes for MUSIC_DIR's fstab line, the layout
   * from .env. fstab is read through one helper (readFstab: only `cat
   * /etc/fstab`) and kept 10 minutes, a failed read (null) only 1 minute.
   * A stale reading is shown at once while it is read again in the
   * background; only the very first read is waited for, no longer than the
   * call's budget (null until it ends). No music folder: null, and nothing
   * runs. Never throws.
   */
  private async musicBoot(env: string, end: number): Promise<MusicBoot | null> {
    if (!musicBootWanted(env)) return null;
    const cached = this.bootFstab;
    const keep = cached?.fstab === null ? BOOT_FAILED_CACHE_MS : BOOT_CACHE_MS;
    if (cached && this.now().getTime() - cached.at < keep) return musicBootOf(cached.fstab, env);
    if (!this.bootRead) {
      const read = this.readBootFstab()
        .then((fstab) => {
          this.bootFstab = { at: this.now().getTime(), fstab };
          return fstab;
        })
        .finally(() => { if (this.bootRead === read) this.bootRead = null; });
      this.bootRead = read;
    }
    if (cached) return musicBootOf(cached.fstab, env);
    const fstab = await beforeEnd(end, this.bootRead, () => null);
    return musicBootOf(fstab, env);
  }

  /** fstab through the helper from the updater's own image; null without an image or when it fails. */
  private async readBootFstab(): Promise<string | null> {
    try {
      const image = this.opts.layoutImage ? await this.opts.layoutImage() : null;
      return image ? await readFstab(this.opts.docker, image) : null;
    } catch {
      return null;
    }
  }

  /** Starts a run in the background. */
  async start(target: string, manifest?: string, signature?: string | null): Promise<{ ok: true; run: UpdateRun } | RefusedStart> {
    if (!TARGET_RE.test(target)) return { ok: false, status: 400, error: 'version must be a release number such as 0.8.0' };
    return this.withClaim('update', () => this.beginUpdate(target, manifest, signature));
  }

  private async beginUpdate(target: string, manifest: string | undefined, signature: string | null | undefined): Promise<{ ok: true; run: UpdateRun } | RefusedStart> {
    const env = (await readText(join(this.opts.installDir, '.env'))) ?? '';
    const from = envGet(env, 'TAGAVE_VERSION') ?? 'unknown';
    // Nothing of the target is used before its signed manifest checks out.
    if (!manifest) return { ok: false, status: 422, error: `the update to ${target} came without its signed release manifest; the updater installs only signed releases`, check: 'unsigned' };
    let verified: VerifiedRelease;
    try {
      verified = await this.verify(target, manifest, signature, TARGET_RE.test(from) ? from : null);
    } catch (err) {
      if (err instanceof ReleaseRefused) return { ok: false, status: 422, error: `${err.message}. Nothing was changed.`, check: err.check };
      throw err;
    }
    const run = newRun(randomUUID(), from, target, new Date());
    const update = new Update(
      {
        installDir: this.opts.installDir,
        docker: this.opts.docker,
        app: this.opts.app,
        config: this.opts.config,
        save: (r) => this.save(r),
        selfReplace: this.selfReplace,
        release: { verified, platform: await this.platform() },
        music: this.opts.music ?? null,
      },
      run,
    );
    this.run = run;
    await this.save(run);
    this.partsChanged();
    // Cleared only while it is still this update's: a later update may claim the slot while afterUpdate awaits.
    const active: Promise<UpdateRun> = update.execute()
      .then(async (r) => {
        if (this.active === active) this.active = null;
        this.partsChanged();
        await this.afterUpdate(r);
        return r;
      })
      .finally(() => {
        void this.rereadServices();
        // Also when execute() rejects: the parts moved either way.
        if (this.active !== active) return;
        this.partsChanged();
        this.active = null;
      });
    this.active = active;
    return { ok: true, run };
  }

  /** Resolves when the running update, module run and repair (if any) have finished; a waiting repair's watcher goes on. For tests. */
  async idle(): Promise<void> {
    await this.active?.catch(() => undefined);
    await this.moduleActive?.catch(() => undefined);
    await this.resuming;
    await this.repairActive?.catch(() => undefined);
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > MAX_BODY) return send(413, { error: 'body too large' });
    }
    const path = req.url ?? '/';
    const header = (n: string) => {
      const v = req.headers[n];
      return Array.isArray(v) ? v[0] : v;
    };
    const auth = this.verifier.verify({ method: req.method ?? 'GET', path, body, time: header(TIME_HEADER), signature: header(SIGNATURE_HEADER) });
    if (!auth.ok) return send(401, { error: auth.reason });

    if (req.method === 'GET' && path === '/v1/status') return send(200, await this.status());
    let json: Record<string, unknown> = {};
    if (req.method === 'POST') {
      try {
        const parsed = JSON.parse(body || '{}') as unknown;
        json = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
      } catch {
        return send(400, { error: 'body must be JSON' });
      }
    }
    const text = (k: string) => (typeof json[k] === 'string' ? (json[k] as string) : undefined);
    const refused = (r: RefusedStart) => send(r.status, { error: r.error, ...(r.check ? { check: r.check } : {}), ...(r.selfReplace ? { selfReplace: r.selfReplace } : {}) });
    if (req.method === 'POST' && path === '/v1/update') {
      const result = await this.start(text('version') ?? '', text('manifest'), text('signature'));
      return result.ok ? send(202, { run: result.run }) : refused(result);
    }
    if (req.method === 'POST' && path === '/v1/repair') {
      const result = await this.startRepair('owner');
      return result.ok ? send(202, { run: result.run }) : refused(result);
    }
    if (req.method === 'GET' && path === '/v1/modules') return send(200, await this.modules());
    if (req.method === 'POST' && path === '/v1/release') {
      const manifest = text('manifest');
      if (!manifest) return send(400, { error: 'manifest is required' });
      const result = await this.acceptRelease(manifest, text('signature') ?? '');
      return result.ok ? send(200, await this.modules()) : refused(result);
    }
    const m = MODULE_PATH_RE.exec(path);
    if (req.method === 'POST' && m) {
      const result = await this.startModule(m[1]!, m[2] as 'enable' | 'disable', json['deleteData'] === true, json['deleteHistory'] === true);
      return result.ok ? send(202, { run: result.run }) : refused(result);
    }
    return send(404, { error: 'not found' });
  }

  listen(port: number, host = '0.0.0.0'): Server {
    const server = createServer((req, res) => {
      this.handle(req, res).catch((err: unknown) => {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: (err as Error).message }));
      });
    });
    server.listen(port, host);
    return server;
  }
}
