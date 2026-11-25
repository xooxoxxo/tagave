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
 * limits and kept 10 s) and the last repair (`repair`).
 *
 * One run at a time: an update, a module run and a running repair refuse
 * each other (409), and all wait while the updater replaces itself. A
 * repair that waits for the music share blocks nothing; its watcher pauses
 * while anything else moves containers.
 */
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { PartState, RepairRun, UpdateRun, UpdaterStatus } from '@tagave/shared/updater';
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
import { readParts } from './parts.js';
import { DEFAULT_REPAIR_CONFIG, REPAIR_STATE_FILE, Repair, newRepairRun, type RepairConfig, type RepairDeps } from './repair.js';

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
/** A repair.json marked running by another process (the installer's one-off) counts for this long. */
const ELSEWHERE_MS = 60 * 60_000;
const RESTARTED_DURING_REPAIR = 'The updater restarted during the repair. Press Repair again.';
const STOPPED_REPAIR = 'The repair stopped. Press Repair again.';

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
  /** Repair limits; default DEFAULT_REPAIR_CONFIG with `config`'s health limit and poll. */
  repairConfig?: Partial<RepairConfig>;
  /** How long a status call waits for the parts (default 6 s). */
  partsDeadlineMs?: number;
}

/** What a repair needs of the music healer (music-heal.ts). */
export interface RepairHealer {
  remount(dir: string, project: string): Promise<RemountResult>;
}

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
  /** The repair of this process: running, or waiting with its watcher. */
  private repair: Repair | null = null;
  private repairActive: Promise<RepairRun> | null = null;
  private readonly repairPath: string;
  private healer: RepairHealer | null = null;
  private partsCache: { at: number; parts: PartState[] } | null = null;
  private partsRefresh: { answered: Map<string, PartState>; done: Promise<void> } | null = null;
  /** load()'s repair of an update that ended with stuck parts. */
  private resuming: Promise<void> | null = null;
  /** The run that is starting (between its checks and its run being under way). */
  private claimed: Claim | null = null;
  /** Bumped when the parts change: a reading begun before it is not kept. */
  private partsGen = 0;

  constructor(private readonly opts: UpdaterOptions) {
    this.verifier = new SignatureVerifier(opts.appSecret);
    this.statePath = join(opts.installDir, STATE_DIR, 'state.json');
    this.modulePath = join(opts.installDir, STATE_DIR, 'module-run.json');
    this.repairPath = join(opts.installDir, REPAIR_STATE_FILE);
    this.selfReplace = new SelfReplaceGate({
      version: opts.version,
      persist: () => this.writeState(),
      handoverRunning: async () => {
        const res = await opts.docker(['ps', '-q', '--filter', `label=${HANDOVER_LABEL}`], { timeoutMs: 15_000 });
        return res.code === 0 ? res.stdout.trim() !== '' : null;
      },
      ...(opts.now ? { now: opts.now } : {}),
      ...(opts.log ? { log: opts.log } : {}),
    });
  }

  /** An update, a module run or a repair (not one that waits for the share) is moving containers: the music self-heal waits. */
  moving(): boolean {
    return this.updating() || this.repairRunning();
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

  private now(): Date {
    return (this.opts.now ?? (() => new Date()))();
  }

  /** The music healer, for a repair's remount (main.ts: the healer's busy reads moving(), so it comes after the service). */
  attachHealer(healer: RepairHealer): void {
    this.healer = healer;
  }

  /** Loads the last runs; a run still marked running was cut off (the updater or the host restarted). */
  async load(): Promise<void> {
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

  /** Ends a repair that no process runs any more: failed, saved, and told to the app (its audit end row). */
  private async failRepair(run: RepairRun, reason: string, message: string): Promise<void> {
    const at = this.now().toISOString();
    const step = run.steps.find((s) => s.status === 'running');
    if (step) Object.assign(step, { status: 'failed', finishedAt: at });
    Object.assign(run, { status: 'failed', finishedAt: at, reason, headline: reason, progress: null, stall: null });
    run.log.push({ at, level: 'error', message });
    await this.saveRepair(run).catch(() => undefined);
    try {
      await this.opts.report?.({ status: 'failed', cause: null });
    } catch {
      /* the run on disk says how it ended */
    }
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
   * database may be half restored. Once per load, and only when a part does
   * not run.
   */
  private async finishStuckUpdate(): Promise<void> {
    const run = this.run;
    if (!run) return;
    const stuck = (run.status === 'held' && (run.held?.parts.length ?? 0) > 0) || (run.status === 'rollback_failed' && (run.stuck?.length ?? 0) > 0);
    if (!stuck) return;
    if (this.repairRun?.status === 'running' || this.repairRun?.status === 'waiting') return;
    const services = await this.services();
    if (services.length === 0) return;
    const parts = await readParts(this.opts.docker, services);
    if (parts.every((p) => p.state === 'running')) return;
    const started = await this.startRepair('update');
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
    // No await from here on: the checks and the claim are one step.
    if (this.claimed) return this.claimedRefusal(this.claimed);
    this.claimed = kind;
    return null;
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
    }
  }

  // -- repair ----------------------------------------------------------------------

  /** A repair runs in this process, or repair.json says one runs elsewhere (the installer's one-off, under 1 h old). */
  private async repairElsewhereOrHere(): Promise<boolean> {
    if (this.repairRunning()) return true;
    await this.refreshRepair();
    const r = this.repairRun;
    return r?.status === 'running' && r.id !== this.repair?.run.id && this.now().getTime() - Date.parse(r.startedAt) < ELSEWHERE_MS;
  }

  /** repair.json, unless this process's repair runs or waits: the installer's one-off writes the same file. */
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
    this.repairRun = run;
    await this.failStale(run);
  }

  /** This process starts, runs or waits on a repair: repair.json is ours, never read back over it. */
  private ownRepair(): boolean {
    return this.claimed === 'repair' || this.repair?.run.status === 'running' || this.repair?.run.status === 'waiting';
  }

  private repairDeps(): RepairDeps {
    const c = this.opts.config;
    return {
      installDir: this.opts.installDir,
      docker: this.opts.docker,
      app: this.opts.app,
      music: this.opts.music ?? null,
      ...(this.opts.musicUnmounted ? { musicUnmounted: this.opts.musicUnmounted } : {}),
      healer: this.healer,
      ...(this.opts.report ? { report: this.opts.report } : {}),
      save: (r) => this.saveRepair(r),
      config: { ...DEFAULT_REPAIR_CONFIG, healthTimeoutMs: c.healthTimeoutMs, pollMs: c.pollMs, ...this.opts.repairConfig },
      ...(this.opts.now ? { now: this.opts.now } : {}),
      busy: () => this.moving(),
    };
  }

  private async saveRepair(run: RepairRun): Promise<void> {
    // A run the owner replaced (Repair pressed while it waited) writes nothing more.
    if (this.repairRun && run.id !== this.repairRun.id) return;
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
    void repair.watch().catch(() => undefined).finally(() => this.partsChanged());
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
    // The new run is the current one first, so a waiting watcher's late save is ignored.
    this.repairRun = run;
    try {
      await this.writeRepair(run);
    } catch (err) {
      // Nothing started: the old run (a waiting one goes on waiting) stays current.
      this.repairRun = before;
      return { ok: false, status: 500, error: `the repair could not be saved: ${(err as Error).message}` };
    }
    // Pressed again while it waits: the watcher stops and the new run starts at check.
    if (this.repair?.run.status === 'waiting') this.repair.cancel();
    const repair = new Repair(this.repairDeps(), run);
    this.repair = repair;
    this.savedStatus = run.status;
    this.partsChanged();
    this.repairActive = repair.execute()
      .then((r) => {
        if (r.status === 'waiting' && this.repair === repair) this.watchRepair(repair);
        return r;
      })
      .finally(() => {
        this.repairActive = null;
        this.partsChanged();
      });
    return { ok: true, run };
  }

  /**
   * The updater is stopping: a waiting repair's watcher stops and the run
   * stays waiting in repair.json (the next start resumes it). A running
   * repair is left to end on its own.
   */
  stop(): void {
    if (this.repair?.run.status === 'waiting') this.repair.cancel();
  }

  /** An update that ended held hands its stuck parts to a repair (Decision 3: the music case). Never throws. */
  private async afterUpdate(run: UpdateRun): Promise<void> {
    if (run.status !== 'held') return;
    try {
      const started = await this.startRepair('update');
      if (!started.ok) this.warn(`the held update could not hand its parts to a repair: ${started.error}`, { runId: run.id });
    } catch (err) {
      this.warn(`the held update could not hand its parts to a repair: ${(err as Error).message}`, { runId: run.id });
    }
  }

  private warn(message: string, fields: Record<string, unknown>): void {
    if (this.opts.log) this.opts.log('warn', message, fields);
    else console.warn(JSON.stringify({ msg: message, level: 'warn', ...fields }));
  }

  // -- parts -----------------------------------------------------------------------

  private async services(): Promise<string[]> {
    const svc = await this.opts.docker(['compose', 'config', '--services'], { timeoutMs: 30_000 }).catch(() => null);
    return svc?.code === 0 ? svc.stdout.split('\n').map((s) => s.trim()).filter((s) => s && s !== 'updater') : [];
  }

  /**
   * Each part's state for /v1/status: kept 10 s; a new reading runs in the
   * background, and a status call waits for it at most partsDeadlineMs. A
   * part with no answer by then reads stuck.
   */
  private async partStates(services: string[]): Promise<PartState[]> {
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
      timer = setTimeout(resolve, this.opts.partsDeadlineMs ?? PARTS_DEADLINE_MS);
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
    this.moduleActive = op.execute().finally(() => { this.moduleActive = null; this.partsChanged(); });
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

  async status(): Promise<UpdaterStatus> {
    const env = (await readText(join(this.opts.installDir, '.env'))) ?? '';
    const services = await this.services();
    await this.refreshRepair();
    return {
      version: this.opts.version,
      configuredVersion: envGet(env, 'TAGAVE_VERSION'),
      role: envGet(env, 'TAGAVE_ROLE'),
      services,
      run: this.run,
      selfReplace: await this.selfReplace.status(),
      parts: await this.partStates(services),
      repair: this.repairRun,
    };
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
