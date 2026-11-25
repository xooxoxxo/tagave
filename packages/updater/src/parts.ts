/**
 * Stops and starts the install's parts one service at a time, each call with
 * its own short limit, so one stuck container cannot hold a step for long.
 *
 * Stop: `compose stop -t 30` (60 s); if that does not end it, the container
 * is looked up and inspected, killed when it still runs, and inspected again.
 * A part that binds the music folder and still will not stop asks the music
 * prober whether its share went silent. Start: `compose up -d --no-deps`
 * (120 s) one part at a time, the database first and the music-bound parts
 * last, then an inspect says whether it runs.
 *
 * readParts says what each part is doing for /v1/status, every call with a
 * 5 s limit, so a stuck part reads as `stuck` and never holds the status.
 *
 * Only `compose stop`, `compose up`, `compose ps`, `kill` and `inspect` run
 * here. Nothing throws: a runner that rejects is a failed call.
 */
import { MUSIC_BOUND, type MusicProber } from './music-probe.js';
import { partName } from './progress.js';
import type { PartRunState, PartState } from '@tagave/shared/updater';
import type { CommandResult, Runner } from './runner.js';

export type StuckCause = 'music_unreachable' | 'stuck_stop' | 'stuck_start';

export interface StuckPart {
  service: string;
  cause: StuckCause;
  server: string | null;
}

export interface PartsResult {
  done: string[];
  stuck: StuckPart[];
}

export const PART_LIMITS = {
  stopMs: 60_000,
  stopGraceSeconds: 30,
  killMs: 30_000,
  upMs: 120_000,
  inspectMs: 30_000,
  psMs: 30_000,
  resendGapMs: 60_000,
};

export interface PartsDeps {
  docker: Runner;
  music: MusicProber | null;
  now: () => number;
  log: (level: 'info' | 'warn' | 'error', message: string) => void;
  /** Turns a `['compose', ...]` argv into the one to run (project or file flags); identity by default. */
  compose?: (args: string[]) => string[];
}

const STOPPED = new Set(['exited', 'created', 'dead']);
const STARTED = new Set(['running', 'restarting']);
const START_STUCK = new Set(['created', 'removing']);
/** Started before everything else: the other parts lean on it. */
const FIRST = 'postgres';

/** A Docker container id: 12 to 64 lowercase hex digits. */
const CONTAINER_ID = /^[0-9a-f]{12,64}$/;
const TIMED_OUT = /timed out after \d+ s/;
const GONE = /No such (?:object|container)/i;

const seconds = (ms: number) => `${Math.round(ms / 1000)} s`;
const timedOut = (r: CommandResult) => TIMED_OUT.test(r.stderr);

export class Parts {
  private readonly compose: (args: string[]) => string[];
  /** `stop:<id>` or `kill:<id>` to when it was sent. */
  private readonly sent = new Map<string, number>();
  /** The last container id seen for each service. */
  private readonly ids = new Map<string, string>();
  private readonly pending = new Map<string, { kind: 'stop' | 'start'; at: number }>();

  constructor(private readonly deps: PartsDeps) {
    this.compose = deps.compose ?? ((args) => args);
  }

  /**
   * In parallel. At most 180 s for each part (stop 60, ps 30, inspect 30,
   * kill 30, inspect 30), plus the music probe for a stuck music-bound part.
   */
  async stopParts(services: string[]): Promise<PartsResult> {
    const outcomes = await Promise.all(services.map((s) => this.stopOne(s)));
    return collect(services, outcomes);
  }

  /** One at a time, music-bound last; parts in `skip` are left alone. */
  async startParts(services: string[], opts: { skip?: string[]; forceRecreate?: boolean } = {}): Promise<PartsResult> {
    const skip = new Set(opts.skip ?? []);
    const wanted = services.filter((s) => !skip.has(s));
    const order = [
      ...wanted.filter((s) => s === FIRST),
      ...wanted.filter((s) => s !== FIRST && !MUSIC_BOUND.includes(s)),
      ...MUSIC_BOUND.filter((s) => wanted.includes(s)),
    ];
    const outcomes: Array<true | StuckPart | null> = [];
    for (const service of order) outcomes.push(await this.startOne(service, opts.forceRecreate === true));
    return collect(order, outcomes);
  }

  /** Since when a stop or start of this service has not ended; null when none. For Readings.stuckFor. */
  stuckSince(service: string): { kind: 'stop' | 'start'; at: number } | null {
    return this.pending.get(service) ?? null;
  }

  // -- stop --------------------------------------------------------------------

  private async stopOne(service: string): Promise<true | StuckPart> {
    const name = partName(service);
    const stopKey = `stop:${this.ids.get(service) ?? `svc:${service}`}`;
    if (this.mayResend(stopKey)) {
      this.mark(service, 'stop');
      const stop = await this.run(this.compose(['compose', 'stop', '-t', String(PART_LIMITS.stopGraceSeconds), service]), PART_LIMITS.stopMs);
      this.sent.set(stopKey, this.deps.now());
      if (stop.code === 0) return this.stopped(service);
      this.deps.log('warn', timedOut(stop)
        ? `${name} did not stop within ${seconds(PART_LIMITS.stopMs)}; stopping it by force`
        : `${name} did not stop (exit ${stop.code}); stopping it by force`);
    } else {
      this.mark(service, 'stop');
    }

    const id = await this.containerId(service);
    if (id === null) return this.stopped(service);
    if (id !== undefined) {
      // A stop sent before the id was known now counts for this container.
      const early = this.sent.get(`stop:svc:${service}`);
      if (early !== undefined) {
        this.sent.delete(`stop:svc:${service}`);
        if (!this.sent.has(`stop:${id}`)) this.sent.set(`stop:${id}`, early);
      }
      if (await this.isStopped(id)) return this.stopped(service);
      if (this.mayResend(`kill:${id}`)) {
        const kill = await this.run(['kill', id], PART_LIMITS.killMs);
        this.sent.set(`kill:${id}`, this.deps.now());
        if (kill.code !== 0) this.deps.log('warn', `${name} could not be stopped by force (${timedOut(kill) ? `no answer within ${seconds(PART_LIMITS.killMs)}` : `exit ${kill.code}`})`);
        if (await this.isStopped(id)) return this.stopped(service);
      }
    }

    const stuck = await this.stuck(service, 'stuck_stop');
    this.deps.log('error', stuck.cause === 'music_unreachable'
      ? `${name} is stuck and won't stop: the music share at ${stuck.server} does not answer`
      : `${name} is stuck and won't stop`);
    return stuck;
  }

  private stopped(service: string): true {
    this.pending.delete(service);
    this.forget(service);
    return true;
  }

  /** Drops the stop and kill records of a part once it is known stopped, or seen running after a start. */
  private forget(service: string): void {
    const id = this.ids.get(service);
    for (const key of [`stop:svc:${service}`, ...(id ? [`stop:${id}`, `kill:${id}`] : [])]) this.sent.delete(key);
  }

  /**
   * Whether the stop or kill under `key` may be sent now, and records it when
   * so. The caller records the time again when the call ends, so the gap runs
   * from the end of the last try: a call that timed out is not sent again
   * right after.
   */
  private mayResend(key: string): boolean {
    const last = this.sent.get(key);
    const now = this.deps.now();
    if (last !== undefined && now - last < PART_LIMITS.resendGapMs) return false;
    this.sent.set(key, now);
    return true;
  }

  private async isStopped(id: string): Promise<boolean> {
    const status = await this.status(id);
    return status === 'gone' || (status !== null && STOPPED.has(status));
  }

  // -- start -------------------------------------------------------------------

  private async startOne(service: string, forceRecreate: boolean): Promise<true | StuckPart | null> {
    const name = partName(service);
    this.mark(service, 'start');
    const up = await this.run(
      this.compose(['compose', 'up', '-d', '--no-deps', ...(forceRecreate ? ['--force-recreate'] : []), service]),
      PART_LIMITS.upMs,
    );
    const late = timedOut(up);
    if (late) this.deps.log('warn', `${name} did not start within ${seconds(PART_LIMITS.upMs)}`);
    else if (up.code !== 0) this.deps.log('warn', `${name} could not be started (exit ${up.code})`);

    const id = await this.containerId(service);
    const status = id ? await this.status(id) : null;
    if (status !== null && STARTED.has(status)) {
      this.pending.delete(service);
      this.forget(service);
      return true;
    }
    if (late || (status !== null && START_STUCK.has(status))) {
      const stuck = await this.stuck(service, 'stuck_start');
      this.deps.log('error', stuck.cause === 'music_unreachable'
        ? `${name} won't start: the music share at ${stuck.server} does not answer`
        : `${name} won't start`);
      return stuck;
    }
    // It ended, but not running: a failed start, not a stuck one.
    this.pending.delete(service);
    if (status === 'gone' || (status !== null && STOPPED.has(status))) this.forget(service);
    this.deps.log('warn', `${name} did not start${status && status !== 'gone' ? ` (it is ${status})` : ''}`);
    return null;
  }

  // -- shared ------------------------------------------------------------------

  private mark(service: string, kind: 'stop' | 'start'): void {
    if (this.pending.get(service)?.kind !== kind) this.pending.set(service, { kind, at: this.deps.now() });
  }

  /** The service's container id; null when it has none, undefined when compose did not answer. */
  private async containerId(service: string): Promise<string | null | undefined> {
    const ps = await this.run(this.compose(['compose', 'ps', '-a', '-q', service]), PART_LIMITS.psMs);
    if (ps.code !== 0) return undefined;
    const id = ps.stdout.trim().split('\n')[0]?.trim() ?? '';
    if (!id) return null;
    if (!CONTAINER_ID.test(id)) {
      this.deps.log('warn', `docker compose gave ${partName(service)} a container id that does not look like one; not using it`);
      return undefined;
    }
    this.ids.set(service, id);
    return id;
  }

  /** The container's state; 'gone' when it no longer exists, null when docker did not say. */
  private async status(id: string): Promise<string | null> {
    const res = await this.run(['inspect', '--format', '{{.State.Status}}', id], PART_LIMITS.inspectMs);
    if (res.code !== 0) return GONE.test(res.stderr) ? 'gone' : null;
    return res.stdout.trim() || null;
  }

  private async stuck(service: string, fallback: 'stuck_stop' | 'stuck_start'): Promise<StuckPart> {
    if (this.deps.music && MUSIC_BOUND.includes(service)) {
      const reading = await this.deps.music.read({ parts: [{ service, stuck: true }] }).catch(() => null);
      if (reading?.verdict === 'music_unreachable') return { service, cause: 'music_unreachable', server: reading.server };
    }
    return { service, cause: fallback, server: null };
  }

  private run(args: string[], timeoutMs: number): Promise<CommandResult> {
    return this.deps.docker(args, { timeoutMs }).catch((err: unknown): CommandResult => ({ code: -1, stdout: '', stderr: String(err) }));
  }
}

function collect(services: string[], outcomes: Array<true | StuckPart | null>): PartsResult {
  const res: PartsResult = { done: [], stuck: [] };
  outcomes.forEach((o, i) => {
    if (o === true) res.done.push(services[i]!);
    else if (o) res.stuck.push(o);
  });
  return res;
}

// -- part states -------------------------------------------------------------

const READ_LIMIT_MS = 5_000;
/** How long past its limit a call may take before readParts stops waiting (a CLI that ignores the kill). */
const READ_GRACE_MS = 500;
const READ_FORMAT = '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}';
const READ_STUCK = new Set(['created', 'removing', 'dead']);

/**
 * Each service's state, all in parallel: `compose ps -a -q` and then
 * `inspect`, each with its own limit (5 s by default). No container is
 * `missing`; a call that times out, fails or never answers is `stuck`.
 */
export async function readParts(docker: Runner, services: string[], opts: { timeoutMs?: number } = {}): Promise<PartState[]> {
  const timeoutMs = opts.timeoutMs ?? READ_LIMIT_MS;
  const call = (args: string[]): Promise<CommandResult> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<CommandResult>((resolve) => {
      timer = setTimeout(() => resolve({ code: -1, stdout: '', stderr: `timed out after ${seconds(timeoutMs)}` }), timeoutMs + READ_GRACE_MS);
      (timer as { unref?: () => void }).unref?.();
    });
    const answer = docker(args, { timeoutMs }).catch((err: unknown): CommandResult => ({ code: -1, stdout: '', stderr: String(err) }));
    return Promise.race([answer, late]).finally(() => clearTimeout(timer));
  };
  const part = (service: string, state: PartRunState, health: string | null = null): PartState => ({ service, state, health });

  return Promise.all(services.map(async (service): Promise<PartState> => {
    const ps = await call(['compose', 'ps', '-a', '-q', service]);
    if (ps.code !== 0) return part(service, 'stuck');
    const id = ps.stdout.trim().split('\n')[0]?.trim() ?? '';
    if (!id) return part(service, 'missing');
    if (!CONTAINER_ID.test(id)) return part(service, 'stuck');

    const res = await call(['inspect', '--format', READ_FORMAT, id]);
    if (res.code !== 0) return part(service, GONE.test(res.stderr) ? 'missing' : 'stuck');
    const [statusText = '', healthText = ''] = res.stdout.trim().split('|');
    const status = statusText.trim();
    const health = healthText.trim() || null;
    // An inspect that answers without a status said nothing: not running.
    if (!status || READ_STUCK.has(status)) return part(service, 'stuck', health);
    if (status === 'exited' || status === 'paused') return part(service, 'stopped', health);
    if (status === 'restarting' || (status === 'running' && health === 'starting')) return part(service, 'starting', health);
    return part(service, 'running', health);
  }));
}
