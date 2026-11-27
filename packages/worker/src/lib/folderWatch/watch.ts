/**
 * The folder watch (vault "tagave - Offline Library Spec", "The folder
 * watch"): a loop on the file worker, every 30 s, that gives each enabled
 * music root a status, online, offline or not connected (unmounted).
 *
 * Port first, path never: for a root on a network share it asks the share's
 * server on its port, and a silent server reads offline without a touch of
 * the path. Otherwise a forked child looks at the root (`probeOnce`). This
 * process reads only /proc/self/mountinfo (procfs, answered by the kernel),
 * never the root's path.
 *
 * One check per root at a time: a root whose check has not ended is skipped,
 * and a tick never waits on a check an earlier tick started, so one hung
 * share holds up neither the other roots nor the next tick.
 *
 * Coming back from offline or not connected queues a scan of the root (PR1);
 * the parked jobs' re-send comes with the park rule.
 */
import { readFile } from 'node:fs/promises';
import { recordReach, rootsToWatch, type RootToWatch } from '@tagave/db';
import { mountPoints, musicMount, sharePort, validServer } from '@tagave/shared/mounts';
import type { WorkerContext } from '../context.js';
import { musicName, realRootPath } from './paths.js';
import { portAnswers } from './port.js';
import { probeOnce } from './probeOnce.js';
import { classify, nextReach, type ProbeOutcome, type Reading, type ReachState } from './reach.js';

const EVERY_MS = 30_000;
const MOUNTINFO = '/proc/self/mountinfo';

export interface FolderWatchDeps {
  ctx: WorkerContext;
  env?: NodeJS.ProcessEnv;
  /** default: readFile('/proc/self/mountinfo') (procfs, never the share) */
  readMountinfo?: () => Promise<string>;
  probe?: typeof probeOnce;
  port?: typeof portAnswers;
  now?: () => Date;
  onlineAgain?: (rootId: string, after: 'offline' | 'unmounted') => Promise<void>;
}

type Deps = Required<Omit<FolderWatchDeps, 'env'>>;

/** The path without trailing slashes, as mountinfo lists it. */
function bare(dir: string): string {
  return dir.length > 1 ? dir.replace(/\/+$/, '') : dir;
}

export class FolderWatch {
  private readonly deps: Deps;
  private readonly everyMs: number;
  private readonly name: string | null;
  /** The reach each root is at, seeded from the database the first time the root is seen. */
  private readonly states = new Map<string, ReachState>();
  /** Roots seen as a mount point of their own at least once (in memory only). */
  private readonly wasMount = new Set<string>();
  /** Roots whose check has not ended. */
  private readonly inFlight = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(deps: FolderWatchDeps, opts: { everyMs?: number } = {}) {
    const { ctx } = deps;
    this.deps = {
      ctx,
      readMountinfo: deps.readMountinfo ?? (() => readFile(MOUNTINFO, 'utf8')),
      probe: deps.probe ?? probeOnce,
      port: deps.port ?? portAnswers,
      now: deps.now ?? (() => new Date()),
      onlineAgain:
        deps.onlineAgain ??
        (async (rootId, after) => {
          await ctx.boss.send('scan.root', { scanRootId: rootId, mode: after === 'offline' ? 'quick' : 'full' }, { singletonKey: `scan:${rootId}` });
        }),
    };
    this.everyMs = opts.everyMs ?? EVERY_MS;
    this.name = musicName(deps.env ?? process.env);
  }

  start(): void {
    if (this.timer) return;
    const run = () => {
      this.tick().catch((err) => this.deps.ctx.logger.warn({ err: (err as Error).message }, 'folder watch: tick failed'));
    };
    this.timer = setInterval(run, this.everyMs);
    this.timer.unref();
    run();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** A check of this root now (a gate deadline, a park): counts as a reading. */
  suspect(rootId: string): void {
    this.tick(rootId).catch((err) => this.deps.ctx.logger.warn({ err: (err as Error).message, scanRootId: rootId }, 'folder watch: check failed'));
  }

  /** One pass over every root (or the one given); returns the readings (tests). */
  async tick(only?: string): Promise<Map<string, Reading>> {
    const roots = await rootsToWatch(this.deps.ctx.sql);
    const seen = new Set(roots.map((r) => r.id));
    if (only === undefined) {
      for (const id of this.states.keys()) if (!seen.has(id)) this.states.delete(id);
    }
    const mountinfo = await this.mountinfo();
    const readings = new Map<string, Reading>();
    const checks: Promise<void>[] = [];
    // No await between the in-flight test and the mark: a tick running beside this one sees it.
    for (const root of roots) {
      if (only !== undefined && root.id !== only) continue;
      if (this.inFlight.has(root.id)) continue;
      this.inFlight.add(root.id);
      checks.push(
        this.check(root, mountinfo)
          .then((r) => void readings.set(root.id, r))
          .catch((err) => this.deps.ctx.logger.warn({ err: (err as Error).message, scanRootId: root.id }, 'folder watch: check failed'))
          .finally(() => this.inFlight.delete(root.id)),
      );
    }
    await Promise.all(checks);
    return readings;
  }

  /** The mount table, or none where there is no procfs (macOS dev, tests): every root is then probed as a local folder. */
  private async mountinfo(): Promise<string> {
    try {
      return await this.deps.readMountinfo();
    } catch {
      return '';
    }
  }

  private async look(root: RootToWatch, real: string, mountinfo: string): Promise<ProbeOutcome> {
    const mount = musicMount(mountinfo, real);
    const server = mount.kind === 'network' && mount.server !== null ? validServer(mount.server) : null;
    const port = mount.fstype !== null ? sharePort(mount.fstype) : null;
    if (server !== null && port !== null && !(await this.deps.port(server, port))) return { kind: 'server_silent' };
    const isMountPoint = mountPoints(mountinfo).has(bare(real));
    const wasMountPoint = this.wasMount.has(root.id);
    if (isMountPoint) this.wasMount.add(root.id);
    const outcome = await this.deps.probe(real, root.known);
    return outcome.kind === 'listing' ? { ...outcome, isMountPoint, wasMountPoint } : outcome;
  }

  private async check(root: RootToWatch, mountinfo: string): Promise<Reading> {
    const real = realRootPath(root.path, this.name);
    const reading = classify(await this.look(root, real, mountinfo));
    const prev = this.states.get(root.id) ?? { reach: root.reach, since: root.reachSince, pendingOffline: null };
    const { state, changed } = nextReach(prev, reading, this.deps.now());
    this.states.set(root.id, state);
    // The reason shown is the reading's while it agrees with the status; a first bad reading while online shows none yet.
    const reason = state.reach === reading.reach ? reading.reason : null;
    await recordReach(this.deps.ctx.sql, root.id, { reach: state.reach, reason, since: state.since, changed });
    if (changed) {
      this.log(root, state.reach, reason);
      if (state.reach === 'online' && (prev.reach === 'offline' || prev.reach === 'unmounted')) {
        await this.deps.onlineAgain(root.id, prev.reach).catch((err) =>
          this.deps.ctx.logger.warn({ err: (err as Error).message, scanRootId: root.id }, 'folder watch: could not queue the scan of a music folder back online'),
        );
      }
    }
    return reading;
  }

  /** Once per change of status. Never the share's server or path: only the root's name and a fixed reason code. */
  private log(root: RootToWatch, reach: ReachState['reach'], reason: Reading['reason']): void {
    const msg = `music folder ${root.displayName} is ${reach}${reason ? ` (${reason})` : ''}`;
    const fields = { scanRootId: root.id, reach, reason };
    if (reach === 'online') this.deps.ctx.logger.info(fields, msg);
    else this.deps.ctx.logger.warn(fields, msg);
  }
}

let current: FolderWatch | null = null;

/** Starts the file worker's watch: the one the gate and the park rule find with `folderWatch()`. */
export function startFolderWatch(ctx: WorkerContext): FolderWatch {
  current?.stop();
  current = new FolderWatch({ ctx });
  current.start();
  return current;
}

export function folderWatch(): FolderWatch | null {
  return current;
}
