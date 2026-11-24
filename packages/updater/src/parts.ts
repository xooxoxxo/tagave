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
 * Only `compose stop`, `compose up`, `compose ps`, `kill` and `inspect` run
 * here. Nothing throws: a runner that rejects is a failed call.
 */
import { MUSIC_BOUND, type MusicProber } from './music-probe.js';
import { partName } from './progress.js';
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

  /** In parallel. At most about 2.5 min. */
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
    const known = this.ids.get(service);
    if (this.mayResend('stop', known ?? `svc:${service}`)) {
      this.mark(service, 'stop');
      const stop = await this.run(this.compose(['compose', 'stop', '-t', String(PART_LIMITS.stopGraceSeconds), service]), PART_LIMITS.stopMs);
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
      if (this.mayResend('kill', id)) {
        const kill = await this.run(['kill', id], PART_LIMITS.killMs);
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

  /** Drops the stop and kill records of a part once it is known stopped, or is being started. */
  private forget(service: string): void {
    const id = this.ids.get(service);
    for (const key of [`stop:svc:${service}`, ...(id ? [`stop:${id}`, `kill:${id}`] : [])]) this.sent.delete(key);
  }

  /** Whether `kind:target` may be sent now, and records it when so. */
  private mayResend(kind: 'stop' | 'kill', target: string): boolean {
    const key = `${kind}:${target}`;
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
    this.forget(service);
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
