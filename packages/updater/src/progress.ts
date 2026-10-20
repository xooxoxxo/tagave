/**
 * What an update is doing right now, and why it stopped moving.
 *
 * - Download progress: `docker pull` prints one line per layer event
 *   ("<12 hex>: Pulling fs layer", "Download complete", "Already exists",
 *   and "Downloading … 12.3MB/45.6MB" on a terminal). With the layer sizes
 *   from the registry (preflight-space.ts) that becomes "downloading
 *   tagave-app, image 2 of 4 (340 MB of 1.1 GB)"; without them, a count of
 *   layers.
 * - Waiting for the app: the container's state (`docker inspect`) and its
 *   last log lines, and Postgres's, say what it does: backing up, applying a
 *   migration, Postgres recovering, out of disk, restarting.
 * - Stalls: a step whose sub-state has not changed for the stall time
 *   (2 min by default) is diagnosed from the same readings: disk full, out
 *   of memory, a port taken, a crash loop, a refused migration, a failing
 *   health check, Postgres recovering, a download that does not move, or
 *   nothing wrong but slow. The run shows the cause and what to do; the
 *   step's own timeout still decides when to give up.
 *
 * Everything here is pure; update.ts runs the docker commands.
 */
import type { UpdateStall, UpdateStallCause } from '@tagave/shared/updater';
import { formatBytes } from './preflight-space.js';

export const DEFAULT_STALL_MS = 2 * 60_000;

// -- download progress ---------------------------------------------------------

const SI: Record<string, number> = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 };

/** "12.3MB" (docker counts in SI units) in bytes; null when it is not a size. */
export function parseSize(text: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*([kKMGT]?B)$/.exec(text.trim());
  if (!m) return null;
  return Math.round(Number(m[1]) * SI[m[2]!.toUpperCase()]!);
}

/** The id docker prints for a layer: the first 12 hex digits of its digest. */
export function shortLayerId(digest: string): string {
  return digest.replace(/^sha256:/, '').slice(0, 12);
}

type LayerState = 'waiting' | 'downloading' | 'done' | 'present';

/**
 * Download progress over every image of one pull. Layers shared by two
 * images are counted once; layers already here ("Already exists") leave the
 * total.
 */
export class PullProgress {
  private sizes = new Map<string, number>();
  private layers = new Map<string, LayerState>();
  private partial = new Map<string, number>();
  private image = 0;
  private images = 0;
  private sizesKnown = true;
  private rest = '';

  private name: string | null = null;

  /**
   * Counts an image's layers before its pull starts, so the byte total
   * covers every image from the first one on; null: the registry did not say.
   */
  plan(layers: Array<{ digest: string; size: number }> | null): void {
    if (!layers) this.sizesKnown = false;
    for (const l of layers ?? []) {
      const id = shortLayerId(l.digest);
      this.sizes.set(id, l.size);
      if (!this.layers.has(id)) this.layers.set(id, 'waiting');
    }
  }

  /** Starts image `index` (1-based) of `count`; `layers` from the registry, or null when unknown; `name` as shown ("tagave-app"). */
  beginImage(index: number, count: number, layers: Array<{ digest: string; size: number }> | null, name: string | null = null): void {
    this.image = index;
    this.images = count;
    this.name = name;
    this.plan(layers);
  }

  /** Feeds output as it comes; true when the summary changed. */
  feed(chunk: string): boolean {
    const before = this.summary();
    const text = this.rest + chunk.replace(/\r/g, '\n');
    const lines = text.split('\n');
    this.rest = (lines.pop() ?? '').slice(-MAX_PARTIAL_LINE);
    for (const line of lines) this.line(line);
    return this.summary() !== before;
  }

  private line(raw: string): void {
    const m = /^\s*([0-9a-f]{12}): (.+?)\s*$/.exec(raw);
    if (!m) return;
    const id = m[1]!;
    const status = m[2]!;
    const was = this.layers.get(id);
    if (was === 'done' || was === 'present') return;
    if (/^Already exists/.test(status)) this.layers.set(id, 'present');
    else if (/^(Download complete|Verifying Checksum|Extracting|Pull complete)/.test(status)) this.layers.set(id, 'done');
    else if (/^Downloading/.test(status)) {
      this.layers.set(id, 'downloading');
      const bytes = /(\d+(?:\.\d+)?\s*[kKMGT]?B)\s*\/\s*(\d+(?:\.\d+)?\s*[kKMGT]?B)/.exec(status);
      if (bytes) {
        const done = parseSize(bytes[1]!);
        const total = parseSize(bytes[2]!);
        if (done !== null) this.partial.set(id, done);
        if (total !== null && !this.sizes.has(id)) this.sizes.set(id, total);
      }
    } else if (!was) this.layers.set(id, 'waiting');
  }

  /**
   * "downloading tagave-app, image 2 of 4 (340 MB of 1.1 GB)" (one image:
   * "downloading tagave-app (…)"; no name: "downloading image 2 of 4 (…)"),
   * or "(3 of 7 layers)" without sizes.
   */
  summary(): string {
    const head = !this.name
      ? `downloading image ${this.image} of ${this.images}`
      : this.images > 1
        ? `downloading ${this.name}, image ${this.image} of ${this.images}`
        : `downloading ${this.name}`;
    const counted = [...this.layers].filter(([, s]) => s !== 'present');
    if (counted.length === 0) return head;
    const sized = this.sizesKnown && counted.every(([id]) => this.sizes.has(id));
    if (sized) {
      const total = counted.reduce((n, [id]) => n + this.sizes.get(id)!, 0);
      const done = counted.reduce((n, [id, s]) => n + (s === 'done' ? this.sizes.get(id)! : Math.min(this.partial.get(id) ?? 0, this.sizes.get(id)!)), 0);
      return `${head} (${formatBytes(done)} of ${formatBytes(total)})`;
    }
    const done = counted.filter(([, s]) => s === 'done').length;
    return `${head} (${done} of ${counted.length} layers)`;
  }
}

/** "ghcr.io/xooxoxxo/tagave-app:0.12.0" → "tagave-app": an image as the run names it. */
export function imageName(ref: string): string {
  const path = ref.split('@')[0]!;
  const last = path.slice(path.lastIndexOf('/') + 1);
  return last.replace(/:[^:]*$/, '') || ref;
}

/** A partial line kept between chunks is cut to this (a line longer than that is not one docker prints). */
export const MAX_PARTIAL_LINE = 4096;

/** `docker compose pull` output, fed as it comes: how many services are pulled, out of `count`. */
export class ComposePullProgress {
  private pulled = new Set<string>();
  private rest = '';

  constructor(private readonly count: number) {}

  /** True when the summary changed. */
  feed(chunk: string): boolean {
    const before = this.pulled.size;
    const lines = (this.rest + chunk).split(/[\r\n]+/);
    this.rest = (lines.pop() ?? '').slice(-MAX_PARTIAL_LINE);
    for (const line of lines) {
      const m = /^\s*(?:✔\s*)?([\w.-]+)\s+Pulled\b/.exec(line);
      if (m) this.pulled.add(m[1]!);
    }
    return this.pulled.size !== before;
  }

  summary(): string {
    return `downloading the images (${Math.min(this.pulled.size, this.count)} of ${this.count} done)`;
  }
}

// -- containers ------------------------------------------------------------------

/** What `docker inspect` says about a container (the parts this needs). */
export interface ContainerState {
  status: string;
  restarting: boolean;
  oomKilled: boolean;
  exitCode: number;
  error: string;
  health: string | null;
  healthLog: string | null;
  restarts: number;
}

/** The format docker inspect is given; parseInspect reads its output. */
export const INSPECT_FORMAT = '{{json .State}}|{{.RestartCount}}';

export function parseInspect(out: string): ContainerState | null {
  const text = out.trim();
  const bar = text.lastIndexOf('|');
  if (bar < 0) return null;
  try {
    const s = JSON.parse(text.slice(0, bar)) as {
      Status?: string;
      Restarting?: boolean;
      OOMKilled?: boolean;
      ExitCode?: number;
      Error?: string;
      Health?: { Status?: string; Log?: Array<{ Output?: string }> } | null;
    };
    const restarts = Number(text.slice(bar + 1));
    const last = s.Health?.Log?.at(-1)?.Output?.trim();
    return {
      status: s.Status ?? 'unknown',
      restarting: s.Restarting === true,
      oomKilled: s.OOMKilled === true,
      exitCode: Number.isFinite(s.ExitCode) ? s.ExitCode! : 0,
      error: s.Error ?? '',
      health: s.Health?.Status ?? null,
      healthLog: last ? last : null,
      restarts: Number.isInteger(restarts) ? restarts : 0,
    };
  } catch {
    return null;
  }
}

/** One container as the updater saw it: its state (null: no container) and its last log lines. */
export interface Observation {
  service: string;
  state: ContainerState | null;
  logs: string;
  /** Its restart count when the step began. */
  restartsBefore: number;
}

export interface Readings {
  observations: Observation[];
  /** Free bytes on Docker's filesystem; null when unknown. */
  dockerFreeBytes: number | null;
  /** Output of a command still running (a pull). */
  commandOutput?: string;
}

const ENOSPC = /no space left on device|ENOSPC|could not extend file|disk is full|database or disk is full/i;
const PORT = /address already in use|port is already allocated|EADDRINUSE|bind: address/i;
const PG_RECOVERING = /database system was interrupted|was not properly shut down|automatic recovery in progress|redo starts at|database system is starting up|in recovery mode|not yet accepting connections/i;
const PG_READY = /database system is ready to accept connections/i;
/** Below this, Docker's disk counts as full. */
const DISK_FULL_BYTES = 256 * 1024 ** 2;

const lines = (s: string) => s.split('\n').map((l) => l.trim()).filter(Boolean);

/** Postgres is replaying its log: a recovery line after the last "ready" line. */
export function postgresRecovering(logs: string): boolean {
  let recovering = false;
  for (const line of lines(logs)) {
    if (PG_READY.test(line)) recovering = false;
    else if (PG_RECOVERING.test(line)) recovering = true;
  }
  return recovering;
}

/** The line worth showing from a container's log: the last error, else the last line. */
export function lastErrorLine(logs: string): string | null {
  const all = lines(logs);
  const line = [...all].reverse().find((l) => /error|fatal|exception|panic|refused|not migrating|will not run/i.test(l)) ?? all.at(-1);
  if (!line) return null;
  const clean = line.replace(/^\{"level":\w+,"time":\d+,.*?"msg":"(.*)"\}$/, '$1');
  return clean.length > 220 ? `${clean.slice(0, 217)}…` : clean;
}

function restartedSince(o: Observation): boolean {
  return !!o.state && (o.state.restarting || o.state.restarts > o.restartsBefore);
}

/** What the new app is doing, from its log: the step it is in, in a few words; null when the log says nothing useful. */
export function appPhase(logs: string): string | null {
  let phase: string | null = null;
  for (const line of lines(logs)) {
    let m: RegExpExecArray | null;
    if ((m = /Not migrating: (.*)/.exec(line))) phase = `it refuses to update the database: ${m[1]!.replace(/\.$/, '')}`;
    else if ((m = /backing up the database to \S+ before applying (\d+) migration/.exec(line))) phase = `backing up the database before ${m[1]} database update${m[1] === '1' ? '' : 's'}`;
    else if (/keeping its backup|reusing|an earlier attempt at this update/.test(line)) phase = 'updating the database (a retry keeps the first backup)';
    else if ((m = /applying (\S+\.sql)/.exec(line))) phase = `updating the database (${m[1]})`;
    else if (/another tagave process is migrating/.test(line)) phase = 'another start of the app is updating the database';
    else if (/still waiting for the other migration run/.test(line)) phase = 'another start of the app is updating the database';
  }
  return phase;
}

/**
 * "waiting for the app: …": the sub-state while the new (or old) app comes
 * up, from the readings; null when they say nothing more than the health
 * check does.
 */
export function waitingFor(r: Readings, app = 'app'): string | null {
  const a = r.observations.find((o) => o.service === app);
  const pg = r.observations.find((o) => o.service === 'postgres');
  if (r.observations.some((o) => ENOSPC.test(o.logs))) return 'no space left on device';
  if (r.dockerFreeBytes !== null && r.dockerFreeBytes < DISK_FULL_BYTES) return 'no space left on device';
  if (pg && postgresRecovering(pg.logs)) return 'database recovering';
  if (a?.state?.oomKilled) return 'it ran out of memory';
  // No count in the words: a rising count must not read as progress (it is the stall).
  if (a && restartedSince(a)) return `it keeps restarting (last exit code ${a.state!.exitCode})`;
  if (a?.state && a.state.status !== 'running') return `its container is ${a.state.status}`;
  return a ? appPhase(a.logs) : null;
}

const minutes = (ms: number) => {
  const m = Math.round(ms / 60_000);
  return m <= 1 ? 'a minute' : `${m} minutes`;
};

/**
 * Why the step has not moved for `stalledMs`. `progress` is the sub-state
 * it is stuck on; `downloading`: the step is pulling images.
 */
export function diagnoseStall(
  r: Readings,
  opts: { progress: string; stalledMs: number; since: string; downloading?: boolean },
): UpdateStall {
  const make = (cause: UpdateStallCause, message: string, advice: string, service: string | null = null): UpdateStall => ({
    cause,
    message,
    advice,
    service,
    since: opts.since,
  });
  const free = 'Free space on the disk Docker uses: docker builder prune, docker image prune, and old backups in Settings › Backups (keep the newest).';
  const full = r.observations.find((o) => ENOSPC.test(o.logs));
  if (full || ENOSPC.test(r.commandOutput ?? '')) {
    return make('disk_full', full ? `${full.service} has no space left on its disk` : 'the download has no space left on the disk', `${free} The update rolls back on its own if it runs out of time.`, full?.service ?? null);
  }
  if (r.dockerFreeBytes !== null && r.dockerFreeBytes < DISK_FULL_BYTES) {
    return make('disk_full', `Docker's disk is full (${formatBytes(r.dockerFreeBytes)} free)`, `${free} The update rolls back on its own if it runs out of time.`);
  }
  const oom = r.observations.find((o) => o.state?.oomKilled);
  if (oom) {
    return make('oom', `${oom.service} was stopped for using too much memory`, 'Give Docker more memory, or stop other containers on this computer, then start the update again. It rolls back on its own if the app does not come up.', oom.service);
  }
  const port = r.observations.find((o) => PORT.test(o.state?.error ?? '') || PORT.test(o.logs));
  if (port) {
    return make('port_conflict', `${port.service} cannot use its port: ${lastErrorLine(port.state?.error || port.logs) ?? 'it is taken'}`, 'Another program uses that port: stop it, or give tagave another one (TAGAVE_PORT in .env), then start the update again.', port.service);
  }
  const refused = r.observations.find((o) => /Not migrating:/.test(o.logs));
  if (refused) {
    const phase = appPhase(refused.logs) ?? 'it refuses to update the database';
    return make('migration_refused', `the new app ${phase.replace(/^it /, '')}`, 'Do what it says; the update rolls back on its own when the app does not come up in time.', refused.service);
  }
  const looping = r.observations.find((o) => o.state && (restartedSince(o) || (o.state.status === 'exited' && o.state.exitCode !== 0)));
  if (looping) {
    const s = looping.state!;
    const n = s.restarts - looping.restartsBefore;
    const line = lastErrorLine(looping.logs);
    return make(
      'crash_loop',
      `${looping.service} keeps stopping (${n > 0 ? `restarted ${n} time${n === 1 ? '' : 's'}, ` : ''}last exit code ${s.exitCode})${line ? `: ${line}` : ''}`,
      `Its last lines are in the log (docker compose logs ${looping.service}). The update rolls back on its own when it runs out of time.`,
      looping.service,
    );
  }
  const sick = r.observations.find((o) => o.state?.health === 'unhealthy');
  if (sick) {
    return make('unhealthy', `${sick.service} fails its health check${sick.state!.healthLog ? `: ${lastErrorLine(sick.state!.healthLog)}` : ''}`, `Look at docker compose logs ${sick.service}. The update rolls back on its own when it runs out of time.`, sick.service);
  }
  const pg = r.observations.find((o) => o.service === 'postgres' && postgresRecovering(o.logs));
  if (pg) {
    return make('db_recovering', 'Postgres is recovering after it was stopped uncleanly', 'Wait: on a large database this can take several minutes. Do not restart it.', 'postgres');
  }
  if (opts.downloading) {
    return make('download', `the download has not moved for ${minutes(opts.stalledMs)}`, "Check this computer's internet connection and that the registry (ghcr.io) answers. The update stops without changing anything if the download fails.");
  }
  return make('slow', `no progress for ${minutes(opts.stalledMs)}, and nothing looks wrong: ${opts.progress}`, 'Wait: a large library can take several minutes here. The update rolls back on its own if it runs out of time.');
}

/** The causes that need the owner; the others ask only for patience. */
export function stallNeedsAction(cause: UpdateStallCause): boolean {
  return cause !== 'slow' && cause !== 'db_recovering';
}
