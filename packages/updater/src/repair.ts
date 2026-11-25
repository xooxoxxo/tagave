/**
 * Repair (Settings › Updates › Repair): checks every part of the install and
 * fixes what it safely can, in five steps.
 *
 *   check   Docker answers (10 s), each part's state, free space, the app's
 *           health, and the music share when a part that binds it is down
 *           or the app says the music folder is unmounted.
 *   stop    parts stuck in Created, removing or dead, restarting, or
 *           unhealthy. Never a part stuck on a silent share, never the app
 *           while it backs up or migrates, never Postgres while it recovers.
 *   music   a share that is not connected is connected again (the healer's
 *           remount); a silent share leaves its parts waiting.
 *   start   parts that do not run, one at a time; a part that crashed or ran
 *           out of memory gets its one `--force-recreate`.
 *   verify  every part runs and the app answers, polled up to
 *           healthTimeoutMs; a crash after the recreate, a refused
 *           migration, Postgres still recovering or an app that still fails
 *           after its one `compose restart app` end the run.
 *
 * It ends repaired, waiting (the music parts wait for a silent share),
 * needs_you (something only the owner can fix) or failed. A waiting run is
 * saved like any other (REPAIR_STATE_FILE); watch() probes the share every
 * waitFirstMs, doubling to waitMaxMs, and finishes the run when it answers.
 *
 * Every docker call has its own limit. Nothing here touches MUSIC_DIR: the
 * music prober and the healer do, with their own limits and rules.
 */
import { statfs as realStatfs } from 'node:fs/promises';
import { join } from 'node:path';
import type { PartState, RepairCause, RepairRun, RepairStatus, RepairStepId, UpdateLogLine } from '@tagave/shared/updater';
import { envGet, readText } from './envFile.js';
import { musicDirOf, type RemountResult } from './music-heal.js';
import { MUSIC_BOUND, type MusicProber, type MusicReading } from './music-probe.js';
import { Parts, readParts, type PartsResult } from './parts.js';
import { formatBytes, type StatfsLike } from './preflight-space.js';
import { ENOSPC, INSPECT_FORMAT, PORT, appPhase, lastErrorLine, parseInspect, partName, postgresRecovering, type ContainerState } from './progress.js';
import { redact } from './redact.js';
import type { AppProbe, CommandResult, Runner } from './runner.js';

export const REPAIR_STATE_FILE = '.updater/repair.json';

export interface RepairConfig {
  /** How long verify waits for every part and the app (and Postgres's recovery). */
  healthTimeoutMs: number;
  pollMs: number;
  /** The watcher's first wait between probes of a silent share, doubled each time up to waitMaxMs. */
  waitFirstMs: number;
  waitMaxMs: number;
  /** Below this much free space the disk counts as full. */
  diskFullBytes: number;
}

export const DEFAULT_REPAIR_CONFIG: RepairConfig = {
  healthTimeoutMs: 10 * 60_000,
  pollMs: 3000,
  waitFirstMs: 60_000,
  waitMaxMs: 300_000,
  diskFullBytes: 256 * 1024 ** 2,
};

export interface RepairDeps {
  installDir: string;
  docker: Runner;
  app: AppProbe;
  music: MusicProber | null;
  /** The app's own music check (`/internal/updater/music`): true when it says the folder is unmounted; null: no answer. */
  musicUnmounted?: () => Promise<boolean | null>;
  healer: { remount(dir: string, project: string): Promise<RemountResult> } | null;
  /** Told when the run settles: on reaching waiting, and when it ends (the app's audit entry); never throws into the run. */
  report?: (end: { status: RepairStatus; cause: RepairCause | null }) => Promise<void>;
  save: (run: RepairRun) => Promise<void>;
  config: RepairConfig;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  statfs?: (path: string) => Promise<StatfsLike>;
  /** Lets the waiting watcher pause while an update or module run moves containers. */
  busy?: () => boolean;
}

export const REPAIR_STEP_LABELS: Record<RepairStepId, string> = {
  check: 'Check every part',
  stop: 'Stop the parts that are stuck',
  music: 'Check the music share',
  start: 'Start the parts that are not running',
  verify: 'Check that every part runs',
};

const STEP_ORDER: RepairStepId[] = ['check', 'stop', 'music', 'start', 'verify'];

const LIMITS = { versionMs: 10_000, configMs: 60_000, observeMs: 30_000, restartAppMs: 120_000 };
const MAX_LOG_LINES = 400;
const CONTAINER_ID = /^[0-9a-f]{12,64}$/;

export function newRepairRun(id: string, trigger: RepairRun['trigger'], now: Date): RepairRun {
  return {
    kind: 'repair',
    id,
    trigger,
    status: 'running',
    startedAt: now.toISOString(),
    finishedAt: null,
    steps: STEP_ORDER.map((s) => ({ id: s, label: REPAIR_STEP_LABELS[s], status: 'pending', startedAt: null, finishedAt: null })),
    log: [],
    progress: null,
    stall: null,
    reason: null,
    outcome: null,
    headline: null,
    details: [],
    checkedAt: null,
  };
}

export interface HeadlineExtra {
  freeBytes?: number;
  port?: number;
  lastError?: string;
  /** failed: the sentence; migration_refused: what the app said. */
  reason?: string;
  /** repaired: something was done (else "Nothing to repair"). */
  acted?: boolean;
  /** stuck_stop: the part would not start rather than not stop. */
  starting?: boolean;
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const NOT_CONNECTED = "Your music folder isn't connected, and tagave can't connect it for you. Connect the drive or share, then press Repair.";
const FAILED = 'The repair could not finish. The run log says why.';

/** The one sentence above the steps: the spec's "User-facing copy" table, keyed by status and cause. */
export function repairHeadline(run: Pick<RepairRun, 'status' | 'outcome'>, extra: HeadlineExtra = {}): string {
  const o = run.outcome;
  const all = `All ${o?.partsTotal ?? 0} parts running.`;
  const part = capital(o?.service ? partName(o.service) : 'a part');
  if (run.status === 'running') return 'Checking every part.';
  if (run.status === 'failed') return extra.reason ?? FAILED;
  if (run.status === 'repaired') {
    if (o?.cause === 'music_unmounted') return `Music share was not connected. Connected it again. ${all}`;
    if (o?.cause === 'music_unreachable') return `Music share is back. ${all}`;
    return extra.acted ? `Repaired. ${all}` : `${all} Nothing to repair.`;
  }
  if (run.status === 'waiting') {
    const share = o?.server ? `Your music share at ${o.server}` : 'Your music share';
    return `${share} doesn't answer. Turn the NAS on or check its cable. tagave finishes on its own when it's back.`;
  }
  switch (o?.cause) {
    case 'not_in_fstab':
    case 'music_unmounted':
      return NOT_CONNECTED;
    case 'music_unreachable':
      return `${o.server ? `Your music share at ${o.server}` : 'Your music share'} doesn't answer. Turn the NAS on or check its cable, then press Repair.`;
    case 'stuck_stop':
      return extra.starting ? `${part} won't start. Restart the computer tagave runs on.` : `${part} is stuck and won't stop. Restart the computer tagave runs on.`;
    case 'crash_loop':
      return `${part} keeps stopping. tagave restarted it once.`;
    case 'oom':
      return `${part} ran out of memory. Close other programs on this computer, then press Repair.`;
    case 'disk_full':
      return extra.freeBytes !== undefined
        ? `The disk is full (${formatBytes(extra.freeBytes)} free). Free up space, then press Repair.`
        : 'The disk is full. Free up space, then press Repair.';
    case 'port_conflict':
      return extra.port !== undefined
        ? `Another program uses port ${extra.port}. Stop that program, then press Repair.`
        : 'Another program uses a port tagave needs. Stop that program, then press Repair.';
    case 'db_recovering':
      return 'The database is recovering after an unclean stop. Wait, this can take a few minutes.';
    case 'app_unhealthy':
      return "The web app doesn't answer. tagave restarted it once.";
    case 'migration_refused':
      return `The web app refuses to update the database: ${(extra.reason ?? 'see the run log').replace(/\.\s*$/, '')}.`;
    case 'docker_unresponsive':
      return "Docker isn't answering. Restart Docker or the computer, then run the installer again.";
    default:
      return extra.reason ?? FAILED;
  }
}

/** What goes behind "?" for an ending, under the actions. */
function helpLines(cause: RepairCause | null, extra: HeadlineExtra): string[] {
  switch (cause) {
    case 'not_in_fstab':
    case 'music_unmounted':
      return ["tagave only connects shares listed in the computer's mount settings."];
    case 'stuck_stop':
      return [extra.starting ? 'Your music and library are safe.' : 'tagave tried to stop it twice. Your music and library are safe.'];
    case 'crash_loop':
    case 'app_unhealthy':
      return extra.lastError ? [`Last error: ${extra.lastError}`] : [];
    case 'disk_full':
      return ['tagave never deletes files for you.'];
    case 'db_recovering':
      return ["Don't restart the computer while it recovers."];
    default:
      return [];
  }
}

/** Ends the run from any step. */
class Ended extends Error {
  constructor(
    readonly status: 'needs_you' | 'failed',
    readonly cause: RepairCause | null,
    readonly extra: HeadlineExtra & { service?: string | null } = {},
  ) {
    super(extra.reason ?? cause ?? status);
  }
}

/** One container as repair reads it: its state (null: none, or Docker did not say) and last log lines. */
interface Seen {
  state: ContainerState | null;
  logs: string;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const timedOut = (r: CommandResult) => /timed out after \d+ s/.test(r.stderr);
const crashed = (s: ContainerState | null | undefined) => !!s && (s.oomKilled || s.restarting || (s.status === 'exited' && s.exitCode !== 0));

/** The most text from a log or the app that goes into a headline, reason or details line. */
const MAX_FREE_TEXT = 300;

/** Text from a log or the app, redacted (whole, so a cut cannot leave half a secret) and then capped. */
export function clip(text: string): string {
  const clean = redact(text);
  return clean.length > MAX_FREE_TEXT ? `${clean.slice(0, MAX_FREE_TEXT - 1)}…` : clean;
}

/** "Bind for 0.0.0.0:4533 failed", "listen tcp :4533: bind": the port on the line that names the conflict; undefined when it names none. */
function portOf(text: string): number | undefined {
  const line = text.split('\n').find((l) => PORT.test(l)) ?? '';
  // The last ":NN" on that line: a timestamp at its start comes first.
  const m = [...line.matchAll(/:(\d{2,5})\b/g)].at(-1);
  const n = m ? Number(m[1]) : NaN;
  return n > 0 && n < 65536 ? n : undefined;
}

/** The text after the app's last "Not migrating:" line. */
function refusal(logs: string): string | null {
  const all = [...logs.matchAll(/Not migrating: (.*)/g)];
  return all.length ? all.at(-1)![1]!.trim() : null;
}

export class Repair {
  readonly run: RepairRun;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly parts: Parts;
  private services: string[] | null = null;
  private musicDir: string | null = null;
  private project = 'tagave';
  private cause: RepairCause | null = null;
  private service: string | null = null;
  private server: string | null = null;
  private readonly actions: string[] = [];
  /** Parts that wait for a silent share: never stopped or started while it is silent. */
  private readonly waiting = new Set<string>();
  private readonly recreated = new Set<string>();
  private restartedApp = false;
  /** The one app restart ran and Docker said it worked. */
  private restartWorked = false;
  /** The watcher said once that it cannot check the share. */
  private toldNoProbe = false;
  private lastParts: PartState[] = [];
  /** What check saw of the parts that were down, and of the app and Postgres. */
  private seen = new Map<string, Seen>();
  private reading: MusicReading | null = null;
  private appFailedAtCheck = false;
  private cancelled = false;
  private wake: (() => void) | null = null;
  private saving: Promise<void> = Promise.resolve();

  constructor(private readonly deps: RepairDeps, run: RepairRun) {
    this.run = run;
    this.now = deps.now ?? (() => new Date());
    this.sleep = deps.sleep ?? realSleep;
    this.parts = new Parts({ docker: deps.docker, music: deps.music, now: () => this.now().getTime(), log: (l, m) => this.log(l, m) });
    // A run loaded from repair.json carries what it found.
    if (run.outcome) {
      this.cause = run.outcome.cause;
      this.service = run.outcome.service;
      this.server = run.outcome.server;
    }
  }

  /** check → stop → music → start → verify; ends repaired, waiting, needs_you or failed. */
  async execute(): Promise<RepairRun> {
    try {
      await this.check();
      await this.stopStuck();
      await this.music();
      await this.start(null);
      await this.verify();
      await this.settle(this.waiting.size > 0 ? 'waiting' : 'repaired');
    } catch (err) {
      await this.ended(err);
    }
    return this.run;
  }

  /** From waiting: probe every waitFirstMs, doubling to waitMaxMs; when the share answers, start → verify. Resolves when the run leaves waiting or is cancelled. */
  async watch(): Promise<RepairRun> {
    let delay = this.deps.config.waitFirstMs;
    try {
      while (this.run.status === 'waiting' && !this.cancelled) {
        await this.pause(delay);
        if (this.cancelled) break;
        if (this.deps.busy?.()) continue;
        if (!this.services) await this.loadInstall();
        const down = (await this.readParts()).filter((p) => MUSIC_BOUND.includes(p.service) && p.state !== 'running').map((p) => p.service);
        if (this.cancelled) break;
        if (down.length === 0) {
          this.log('info', 'the parts that waited for the music share run again');
          await this.resume(down, null);
          continue;
        }
        if (!this.deps.music) {
          if (!this.toldNoProbe) this.log('warn', 'the music share cannot be checked here, so tagave waits until the parts run again or Repair is pressed');
          this.toldNoProbe = true;
          delay = Math.min(delay * 2, this.deps.config.waitMaxMs);
          continue;
        }
        const unmounted = this.deps.musicUnmounted ? await this.deps.musicUnmounted().catch(() => null) : null;
        const reading = await this.deps.music.read({ parts: down.map((service) => ({ service, stuck: true })), appUnmounted: unmounted }).catch(() => null);
        // Cancelled while it probed (Repair pressed again): a fresh run owns the parts now.
        if (this.cancelled) break;
        this.run.checkedAt = this.now().toISOString();
        if (reading?.answer === 'answers') {
          this.log('info', 'the music share answers again');
          await this.resume(down, null);
        } else if (reading && reading.answer === null) {
          // No longer a network share (a local folder, or not mounted at all): the music step decides.
          this.log('info', 'the music folder is no longer on a network share');
          await this.resume(down, reading);
        } else {
          delay = Math.min(delay * 2, this.deps.config.waitMaxMs);
          void this.persist();
        }
      }
    } catch (err) {
      await this.ended(err);
    }
    return this.run;
  }

  /** Stops the watcher; the run stays as it is. */
  cancel(): void {
    this.cancelled = true;
    this.wake?.();
  }

  // -- the steps ---------------------------------------------------------------

  private async check(): Promise<void> {
    this.begin('check', 'asking Docker');
    const version = await this.docker(['version', '--format', '{{.Server.Version}}'], LIMITS.versionMs);
    if (version.code !== 0) {
      this.log('error', timedOut(version) ? 'Docker did not answer within 10 s' : `Docker did not answer (exit ${version.code})`);
      throw new Ended('needs_you', 'docker_unresponsive');
    }
    await this.loadInstall();
    const services = this.services!;

    this.progress('reading the parts');
    const parts = await this.readParts();
    const down = parts.filter((p) => p.state !== 'running').map((p) => p.service);
    this.log('info', `parts: ${parts.map((p) => `${p.service} ${p.state}`).join(', ')}`);
    this.seen = await this.observe(services.filter((s) => down.includes(s) || s === 'app' || s === 'postgres'));

    const free = await this.freeBytes();
    if (free !== null && free < this.deps.config.diskFullBytes) throw new Ended('needs_you', 'disk_full', { freeBytes: free });
    const full = down.find((s) => ENOSPC.test(this.seen.get(s)?.logs ?? ''));
    if (full) throw new Ended('needs_you', 'disk_full', { service: full, ...(free !== null ? { freeBytes: free } : {}) });
    for (const s of down) {
      const o = this.seen.get(s);
      const text = `${o?.state?.error ?? ''}\n${o?.logs ?? ''}`;
      if (PORT.test(text)) {
        const port = portOf(text);
        throw new Ended('needs_you', 'port_conflict', { service: s, ...(port !== undefined ? { port } : {}) });
      }
    }

    if (services.includes('app')) {
      const health = await this.deps.app.health();
      this.appFailedAtCheck = !health.ok && !down.includes('app');
      if (!health.ok) this.log('warn', `the app does not answer: ${health.detail}`);
    }

    const musicDown = down.filter((s) => MUSIC_BOUND.includes(s));
    const unmounted = this.deps.musicUnmounted ? await this.deps.musicUnmounted().catch(() => null) : null;
    if (this.deps.music && (musicDown.length > 0 || unmounted === true)) {
      this.progress('checking the music share');
      this.reading = await this.deps.music.read({ parts: musicDown.map((service) => ({ service, stuck: true })), appUnmounted: unmounted }).catch(() => null);
      this.run.checkedAt = this.now().toISOString();
      if (this.reading?.verdict === 'music_unreachable') {
        this.note('music_unreachable', musicDown[0] ?? null);
        this.server = this.reading.server;
        for (const s of musicDown) this.waiting.add(s);
        this.log('warn', `the music share${this.server ? ` at ${this.server}` : ''} does not answer`);
      } else if (this.reading?.verdict === 'music_unmounted') {
        this.log('warn', 'the music folder is not connected');
      }
    }
    this.end('check', 'done');
  }

  private async stopStuck(): Promise<void> {
    const pgBusy = postgresRecovering(this.seen.get('postgres')?.logs ?? '');
    const appBusy = appPhase(this.seen.get('app')?.logs ?? '') !== null;
    const targets = this.lastParts.filter((p) => {
      if (this.waiting.has(p.service)) return false;
      if (p.service === 'postgres' && pgBusy) return false;
      if (p.service === 'app' && (appBusy || p.state !== 'stuck')) return false;
      return p.state === 'stuck' || this.seen.get(p.service)?.state?.restarting === true || p.health === 'unhealthy';
    }).map((p) => p.service);
    if (targets.length === 0) return this.skip('stop');
    this.begin('stop', `stopping ${targets.map(partName).join(', ')}`);
    const res = await this.parts.stopParts(targets);
    for (const s of res.done) this.act(`Stopped ${partName(s)}.`);
    this.stuckOnes(res, false);
    this.end('stop', 'done');
  }

  private async music(): Promise<void> {
    const r = this.reading;
    if (r?.verdict !== 'music_unmounted') {
      if (r?.verdict === 'music_unreachable') {
        this.begin('music', 'the music share does not answer');
        return this.end('music', 'done');
      }
      return this.skip('music');
    }
    this.begin('music', 'connecting the music share');
    this.note('music_unmounted', null);
    if (!this.deps.healer || !this.musicDir) throw new Ended('needs_you', 'music_unmounted');
    const result: RemountResult = await this.deps.healer.remount(this.musicDir, this.project).catch(() => 'docker_failed' as const);
    this.log(result === 'mounted' ? 'info' : 'warn', `connecting the music share ended: ${result}`);
    switch (result) {
      case 'mounted':
        this.act('Connected the music share again.');
        return this.end('music', 'done');
      case 'not_in_fstab':
        this.cause = 'not_in_fstab';
        throw new Ended('needs_you', 'not_in_fstab');
      case 'off':
        throw new Ended('needs_you', 'music_unmounted');
      case 'server_silent':
        this.cause = 'music_unreachable';
        this.server = r.server;
        for (const p of this.lastParts) if (MUSIC_BOUND.includes(p.service) && p.state !== 'running') this.waiting.add(p.service);
        // No part waits for it, so nothing finishes on its own: the owner turns the share on and presses Repair.
        if (this.waiting.size === 0) throw new Ended('needs_you', 'music_unreachable');
        return this.end('music', 'done');
      case 'busy':
        throw new Ended('failed', null, { reason: 'Another change is under way. Press Repair again when it ends.' });
      default:
        throw new Ended('failed', null, { reason: 'tagave could not connect the music share. The run log says why.' });
    }
  }

  /** Starts the parts that do not run; `only`: just these (the watcher's), else every part. */
  private async start(only: string[] | null): Promise<void> {
    const parts = await this.readParts();
    const down = parts
      .filter((p) => (only ? only.includes(p.service) : true) && !this.waiting.has(p.service))
      .filter((p) => p.state === 'stopped' || p.state === 'missing' || p.state === 'stuck')
      .map((p) => p.service);
    if (down.length === 0) return this.skip('start');
    this.begin('start', `starting ${down.map(partName).join(', ')}`);
    for (const s of down) {
      const st = this.seen.get(s)?.state;
      if (parts.find((p) => p.service === s)?.state === 'missing') this.note('missing', s);
      else if (st?.oomKilled) this.note('oom', s);
      else if (crashed(st)) this.note('crash_loop', s);
    }
    const recreate = down.filter((s) => crashed(this.seen.get(s)?.state));
    const plain = down.filter((s) => !recreate.includes(s));
    if (plain.length) {
      const res = await this.parts.startParts(plain);
      for (const s of res.done) this.act(`Started ${partName(s)}.`);
      this.stuckOnes(res, true);
    }
    if (recreate.length) {
      for (const s of recreate) this.recreated.add(s);
      const res = await this.parts.startParts(recreate, { forceRecreate: true });
      for (const s of res.done) this.act(`Started ${partName(s)} again from scratch.`);
      this.stuckOnes(res, true);
    }
    this.end('start', 'done');
  }

  /** Polls until every part (but the waiting ones) runs and the app answers, up to healthTimeoutMs. */
  private async verify(): Promise<void> {
    const services = this.services!;
    this.begin('verify', 'checking every part runs');
    let deadline = this.now().getTime() + this.deps.config.healthTimeoutMs;
    let extended = false;
    for (;;) {
      const parts = await this.readParts();
      const down = parts.filter((p) => !this.waiting.has(p.service) && p.state !== 'running').map((p) => p.service);
      const seen = await this.observe([...new Set([...down, ...services.filter((s) => s === 'app' || s === 'postgres')])]);
      const pgBusy = postgresRecovering(seen.get('postgres')?.logs ?? '');
      if (pgBusy) this.note('db_recovering', 'postgres');
      const appLogs = seen.get('app')?.logs ?? '';
      const phase = appPhase(appLogs);

      let retried = false;
      for (const s of down) {
        const st = seen.get(s)?.state;
        if (!crashed(st) || (s === 'postgres' && pgBusy) || (s === 'app' && phase)) continue;
        if (this.recreated.has(s)) {
          throw new Ended('needs_you', st!.oomKilled ? 'oom' : 'crash_loop', { service: s, ...this.lastError(seen.get(s)!.logs) });
        }
        this.note(st!.oomKilled ? 'oom' : 'crash_loop', s);
        this.recreated.add(s);
        this.progress(`starting ${partName(s)} again from scratch`);
        const res = await this.parts.startParts([s], { forceRecreate: true });
        this.stuckOnes(res, true);
        if (res.done.includes(s)) this.act(`Started ${partName(s)} again from scratch.`);
        retried = true;
      }

      const appIssue = !retried && services.includes('app') && !this.waiting.has('app') ? await this.appIssue() : null;
      if (appIssue) {
        const refused = refusal(appLogs);
        if (refused) throw new Ended('needs_you', 'migration_refused', { service: 'app', reason: clip(refused) });
      }
      if (!retried && down.length === 0 && !appIssue && !pgBusy) break;

      const late = this.now().getTime() >= deadline;
      // The one restart, only once every other part runs (not while the database still comes up).
      const mayRestart = appIssue && !phase && !pgBusy && !this.restartedApp && down.length === 0;
      if (mayRestart && (this.appFailedAtCheck || (late && !extended))) {
        this.note('app_unhealthy', 'app');
        this.restartedApp = true;
        this.progress('restarting the web app');
        const res = await this.docker(['compose', 'restart', 'app'], LIMITS.restartAppMs);
        this.restartWorked = res.code === 0;
        this.log(res.code === 0 ? 'info' : 'warn', res.code === 0 ? 'restarted the web app' : `the web app could not be restarted (${timedOut(res) ? 'no answer within 120 s' : `exit ${res.code}`})`);
        if (this.restartWorked) this.act('Restarted the web app.');
        if (late) {
          extended = true;
          deadline = this.now().getTime() + this.deps.config.healthTimeoutMs;
        }
      } else if (late) {
        if (pgBusy) throw new Ended('needs_you', 'db_recovering', { service: 'postgres' });
        if (appIssue && phase) throw new Ended('failed', null, { reason: `The web app is still busy (${clip(phase)}). Press Repair again when it is done.` });
        // "tagave restarted it once" only when that restart ran and worked; else the app won't start.
        if (appIssue && this.restartWorked) throw new Ended('needs_you', 'app_unhealthy', { service: 'app', ...this.lastError(appLogs) });
        if (down.length) throw new Ended('needs_you', 'stuck_stop', { service: down.includes('app') ? 'app' : down[0]!, starting: true });
        if (appIssue) throw new Ended('needs_you', 'stuck_stop', { service: 'app', starting: true });
      }
      this.progress(down.length ? `waiting for ${down.map(partName).join(', ')}` : appIssue ? `waiting for the web app: ${appIssue}` : 'waiting for the database to recover');
      await this.sleep(this.deps.config.pollMs);
    }
    this.end('verify', 'done');
  }

  /**
   * The watcher's way back in: stop what is still stuck, start, verify.
   * `reading`: the share is no longer a network one, so the music step runs
   * on it first (a folder that is not connected goes to the remount).
   */
  private async resume(down: string[], reading: MusicReading | null): Promise<void> {
    this.waiting.clear();
    this.run.status = 'running';
    this.run.finishedAt = null;
    const again: RepairStepId[] = reading?.verdict === 'music_unmounted' ? ['music', 'start', 'verify'] : ['start', 'verify'];
    for (const s of this.run.steps) if (again.includes(s.id)) Object.assign(s, { status: 'pending', startedAt: null, finishedAt: null });
    if (reading?.verdict === 'music_unmounted') {
      this.cause = 'music_unmounted';
      this.server = null;
      this.reading = reading;
      await this.music();
    }
    const stuck = (await this.readParts()).filter((p) => down.includes(p.service) && p.state === 'stuck').map((p) => p.service);
    if (stuck.length) this.stuckOnes(await this.parts.stopParts(stuck), false);
    this.seen = await this.observe(down);
    await this.start(down);
    await this.verify();
    await this.settle(this.waiting.size > 0 ? 'waiting' : 'repaired');
  }

  // -- endings -----------------------------------------------------------------

  /** Parts that would not stop or start: a silent share leaves them waiting; anything else needs the owner. */
  private stuckOnes(res: PartsResult, starting: boolean): void {
    for (const p of res.stuck) {
      if (p.cause === 'music_unreachable') {
        this.note('music_unreachable', p.service);
        this.server = p.server ?? this.server;
        this.waiting.add(p.service);
      } else {
        throw new Ended('needs_you', 'stuck_stop', { service: p.service, starting: starting || p.cause === 'stuck_start' });
      }
    }
  }

  private async ended(err: unknown): Promise<void> {
    const running = this.run.steps.find((s) => s.status === 'running');
    if (running) this.end(running.id, 'failed');
    if (err instanceof Ended) {
      if (err.cause) {
        this.cause = err.cause;
        if (err.extra.service !== undefined) this.service = err.extra.service;
      }
      if (err.status === 'failed') this.run.reason = err.extra.reason ?? FAILED;
      return this.settle(err.status, err.extra);
    }
    this.log('error', `the repair stopped: ${(err as Error)?.message ?? String(err)}`);
    this.run.reason = FAILED;
    return this.settle('failed', {});
  }

  private async settle(status: Exclude<RepairStatus, 'running'>, extra: HeadlineExtra = {}): Promise<void> {
    const total = this.services?.length ?? 0;
    const runningNow = this.lastParts.filter((p) => p.state === 'running').length;
    this.run.status = status;
    this.run.outcome = { cause: this.cause, service: this.service, server: this.server, partsRunning: runningNow, partsTotal: total };
    const words: HeadlineExtra = { ...extra, acted: this.actions.length > 0 };
    this.run.headline = redact(repairHeadline(this.run, words));
    if (status === 'needs_you') this.run.reason = this.run.headline;
    if (this.run.reason !== null) this.run.reason = redact(this.run.reason);
    const waits = [...this.waiting];
    this.run.details = [
      ...this.actions,
      ...(status === 'needs_you' || status === 'failed' ? helpLines(this.cause, words) : []),
      `${runningNow} of ${total} parts running.`,
      ...(status === 'waiting' && waits.length ? [`${capital(waits.map(partName).join(' and '))} ${waits.length === 1 ? 'waits' : 'wait'} for the share.`] : []),
    ].map(redact);
    this.run.progress = null;
    this.run.finishedAt = status === 'waiting' ? null : this.now().toISOString();
    this.log(status === 'repaired' || status === 'waiting' ? 'info' : 'warn', this.run.headline);
    await this.persist();
    try {
      await this.deps.report?.({ status, cause: this.cause });
    } catch (err) {
      this.log('warn', `could not tell the app how the repair ended: ${(err as Error)?.message ?? String(err)}`);
      await this.persist();
    }
  }

  // -- readings ----------------------------------------------------------------

  private async loadInstall(): Promise<void> {
    const env = (await readText(join(this.deps.installDir, '.env'))) ?? '';
    this.musicDir = musicDirOf(env);
    this.project = envGet(env, 'COMPOSE_PROJECT_NAME') || 'tagave';
    const svc = await this.docker(['compose', 'config', '--services'], LIMITS.configMs);
    if (svc.code !== 0) throw new Ended('failed', null, { reason: 'tagave cannot read its own setup. The run log says why.' });
    this.services = svc.stdout.split('\n').map((s) => s.trim()).filter((s) => s && s !== 'updater');
  }

  private async readParts(): Promise<PartState[]> {
    this.lastParts = await readParts(this.deps.docker, this.services ?? []);
    return this.lastParts;
  }

  /** Each service's container state and last 40 log lines, in parallel, each call with its own limit. */
  private async observe(services: string[]): Promise<Map<string, Seen>> {
    const out = new Map<string, Seen>();
    await Promise.all(services.map(async (service) => {
      const ps = await this.docker(['compose', 'ps', '-a', '-q', service], LIMITS.observeMs);
      const cid = ps.code === 0 ? (ps.stdout.trim().split('\n')[0]?.trim() ?? '') : '';
      if (!CONTAINER_ID.test(cid)) return void out.set(service, { state: null, logs: '' });
      const [inspect, logs] = await Promise.all([
        this.docker(['inspect', '--format', INSPECT_FORMAT, cid], LIMITS.observeMs),
        this.docker(['logs', '--tail', '40', cid], LIMITS.observeMs),
      ]);
      out.set(service, { state: inspect.code === 0 ? parseInspect(inspect.stdout) : null, logs: logs.code === 0 ? `${logs.stdout}\n${logs.stderr}` : '' });
    }));
    return out;
  }

  private async freeBytes(): Promise<number | null> {
    try {
      const st = await (this.deps.statfs ?? realStatfs)('/');
      return st.bavail * st.bsize;
    } catch {
      return null;
    }
  }

  /** What is wrong with the app as appOn sees it: health, then its version; null when it answers. */
  private async appIssue(): Promise<string | null> {
    const h = await this.deps.app.health();
    if (!h.ok) return h.detail;
    return (await this.deps.app.versions()) ? null : 'the app does not report its version yet';
  }

  private lastError(logs: string): { lastError?: string } {
    const line = lastErrorLine(logs);
    return line ? { lastError: clip(line) } : {};
  }

  // -- bookkeeping -------------------------------------------------------------

  /** The first thing found wrong is the run's cause; a later finding only logs. */
  private note(cause: RepairCause, service: string | null): void {
    if (this.cause !== null) return;
    this.cause = cause;
    this.service = service;
  }

  private act(line: string): void {
    this.actions.push(line);
  }

  private docker(args: string[], timeoutMs: number): Promise<CommandResult> {
    return this.deps.docker(args, { timeoutMs }).catch((err: unknown): CommandResult => ({ code: -1, stdout: '', stderr: String(err) }));
  }

  private pause(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this.wake = resolve;
      void this.sleep(ms).then(resolve, resolve);
    }).finally(() => { this.wake = null; });
  }

  private persist(): Promise<void> {
    const snapshot = structuredClone(this.run);
    this.saving = this.saving.then(() => this.deps.save(snapshot)).catch(() => undefined);
    return this.saving;
  }

  private log(level: UpdateLogLine['level'], message: string): void {
    this.run.log.push({ at: this.now().toISOString(), level, message: redact(message) });
    if (this.run.log.length > MAX_LOG_LINES) this.run.log.splice(0, this.run.log.length - MAX_LOG_LINES);
    void this.persist();
  }

  private step(id: RepairStepId) {
    return this.run.steps.find((s) => s.id === id)!;
  }

  private begin(id: RepairStepId, message: string): void {
    const s = this.step(id);
    s.status = 'running';
    s.startedAt = this.now().toISOString();
    this.run.progress = { step: id, message, at: s.startedAt };
    this.log('info', s.label);
  }

  private progress(message: string): void {
    const step = this.run.steps.find((s) => s.status === 'running')?.id ?? 'check';
    if (this.run.progress?.message === message) return;
    this.run.progress = { step, message, at: this.now().toISOString() };
    void this.persist();
  }

  private end(id: RepairStepId, status: 'done' | 'failed'): void {
    const s = this.step(id);
    s.status = status;
    s.finishedAt = this.now().toISOString();
    void this.persist();
  }

  private skip(id: RepairStepId): void {
    const s = this.step(id);
    s.status = 'skipped';
    s.finishedAt = this.now().toISOString();
    void this.persist();
  }
}
