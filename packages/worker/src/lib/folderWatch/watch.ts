/**
 * The folder watch (vault "tagave - Offline Library Spec", "The folder
 * watch"): a loop on the file worker, every 30 s, that gives each enabled
 * music root a status, online, offline or not connected (unmounted).
 *
 * Port first, path never: for a root on a network share it asks the share's
 * server on its port, and a silent server reads offline without a touch of
 * the path. Otherwise the file gate's helpers look at the root (`gateProbe`):
 * a probe passes the gate's stuck cap, and while the root's last probe
 * helper is still stuck, it reads a deadline without forking another. This
 * process reads only /proc/self/mountinfo (procfs, answered by the kernel,
 * mountTable.ts), never the root's path.
 *
 * One check per root at a time: a root whose check has not ended is skipped,
 * and a tick never waits on a check an earlier tick started, so one hung
 * share holds up neither the other roots nor the next tick. A full tick that
 * comes while an earlier one still waits for its roots from the database is
 * skipped, so slow queries do not pile up.
 *
 * Without a mount table (not Linux, or procfs unreadable) the mount-point
 * rule is off for that tick: no root reads as having lost its mount point.
 *
 * Coming back from offline or not connected (`onlineAgain`) sends the
 * root's parked work again and queues a scan of the root.
 */
import { databaseNow, dispatchMaintenanceTask, maintenanceSender, parkedSender, recordReach, releaseParkedRows, rootsToWatch, type RootToWatch } from '@tagave/db';
import { musicMount, sharePort, validServer } from '@tagave/shared/mounts';
import type { WorkerContext } from '../context.js';
import { fileGate } from '../fileGate.js';
import { musicName, realRootPath } from './paths.js';
import { inMountTable, readMountinfo } from './mountTable.js';
import { portAnswers } from './port.js';
import { gateProbe } from './probe.js';
import { classify, nextReach, type ProbeOutcome, type Reading, type ReachState } from './reach.js';

const EVERY_MS = 30_000;

/** One look at a root's path: `dir` is the real path, `known` the sampled files relative to it. */
export type RootProbe = (rootId: string, dir: string, known: string[]) => Promise<ProbeOutcome>;

export interface FolderWatchDeps {
  ctx: WorkerContext;
  env?: NodeJS.ProcessEnv;
  /** default: /proc/self/mountinfo (procfs, never the share; mountTable.ts) */
  readMountinfo?: () => Promise<string>;
  /** default: `gateProbe` through the process's file gate */
  probe?: RootProbe;
  port?: typeof portAnswers;
  now?: () => Date;
  onlineAgain?: (rootId: string, after: 'offline' | 'unmounted', before?: Date) => Promise<void>;
  /** default: `stillOnline(ctx)` (each reading of online that is not a return) */
  stillOnline?: (rootId: string, before: Date) => Promise<void>;
  /** default: db `recordReach` */
  record?: typeof recordReach;
  /** default: db `rootsToWatch` */
  roots?: typeof rootsToWatch;
}

type Deps = Required<Omit<FolderWatchDeps, 'env'>>;

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
  /** A full tick is waiting for its roots (and the mount table). */
  private loadingRoots = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(deps: FolderWatchDeps, opts: { everyMs?: number } = {}) {
    const { ctx } = deps;
    this.deps = {
      ctx,
      readMountinfo: deps.readMountinfo ?? readMountinfo,
      probe: deps.probe ?? ((rootId, dir, known) => gateProbe(fileGate(), rootId, dir, known)),
      record: deps.record ?? recordReach,
      roots: deps.roots ?? rootsToWatch,
      port: deps.port ?? portAnswers,
      now: deps.now ?? (() => new Date()),
      onlineAgain: deps.onlineAgain ?? onlineAgain(ctx),
      stillOnline: deps.stillOnline ?? stillOnline(ctx),
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
    // The running watch stops hearing of the gate's deadlines (R18).
    if (current === this) {
      fileGate().setOnSuspect(null);
      current = null;
    }
  }

  /** A check of this root now (a gate deadline, a park): counts as a reading. */
  suspect(rootId: string): void {
    this.tick(rootId).catch((err) => this.deps.ctx.logger.warn({ err: (err as Error).message, scanRootId: rootId }, 'folder watch: check failed'));
  }

  /** One pass over every root (or the one given); returns the readings (tests). */
  async tick(only?: string): Promise<Map<string, Reading>> {
    const readings = new Map<string, Reading>();
    // A full tick while an earlier one still waits for the database is skipped (a check of one root is not).
    if (only === undefined && this.loadingRoots) return readings;
    if (only === undefined) this.loadingRoots = true;
    let roots: RootToWatch[];
    let mountinfo: string | null;
    try {
      roots = await this.deps.roots(this.deps.ctx.sql);
      mountinfo = await this.mountinfo();
    } finally {
      if (only === undefined) this.loadingRoots = false;
    }
    const seen = new Set(roots.map((r) => r.id));
    if (only === undefined) {
      for (const id of this.states.keys()) if (!seen.has(id)) this.states.delete(id);
      for (const id of this.wasMount) if (!seen.has(id)) this.wasMount.delete(id);
    }
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

  /**
   * The mount table, or null where it cannot be read (no procfs: macOS dev,
   * tests): every root is then probed as a local folder, and the mount-point
   * rule is off for the tick.
   */
  private async mountinfo(): Promise<string | null> {
    try {
      return await this.deps.readMountinfo();
    } catch {
      return null;
    }
  }

  private async look(root: RootToWatch, real: string, mountinfo: string | null): Promise<ProbeOutcome> {
    const mount = musicMount(mountinfo ?? '', real);
    const server = mount.kind === 'network' && mount.server !== null ? validServer(mount.server) : null;
    const port = mount.fstype !== null ? sharePort(mount.fstype) : null;
    if (server !== null && port !== null && !(await this.deps.port(server, port))) return { kind: 'server_silent' };
    // No mount table: no lost mount point (not "not a mount point"), and what was seen before is kept.
    const isMountPoint = mountinfo !== null && inMountTable(mountinfo, real);
    const wasMountPoint = mountinfo !== null && this.wasMount.has(root.id);
    if (isMountPoint) this.wasMount.add(root.id);
    const outcome = await this.deps.probe(root.id, real, root.known);
    return outcome.kind === 'listing' ? { ...outcome, isMountPoint, wasMountPoint } : outcome;
  }

  private async check(root: RootToWatch, mountinfo: string | null): Promise<Reading> {
    // the reading's start, on the database's clock: only work parked before it is let go below
    const started = await databaseNow(this.deps.ctx.sql);
    const real = realRootPath(root.path, this.name);
    const reading = classify(await this.look(root, real, mountinfo));
    const prev = this.states.get(root.id) ?? { reach: root.reach, since: root.reachSince, pendingOffline: null };
    const { state, changed } = nextReach(prev, reading, this.deps.now());
    // The reason shown is the reading's while it agrees with the status; a first bad reading while online shows none yet.
    const reason = state.reach === reading.reach ? reading.reason : null;
    // Written first: a failed write leaves memory as it was, so the next tick makes the same change again.
    await this.deps.record(this.deps.ctx.sql, root.id, { reach: state.reach, reason, since: state.since, changed });
    this.states.set(root.id, state);
    if (changed) this.log(root, state.reach, reason);
    if (state.reach !== 'online') return reading;
    if (changed && (prev.reach === 'offline' || prev.reach === 'unmounted')) {
      await this.deps.onlineAgain(root.id, prev.reach, started).catch((err) =>
        this.deps.ctx.logger.warn({ err: (err as Error).message, scanRootId: root.id }, 'folder watch: could not send the work of a music folder back online'),
      );
    } else if (reading.reach === 'online') {
      // Online and staying so: work that parked meanwhile (a deadline the watch never saw as an outage) goes
      // again. Not on a bad reading the status has not followed yet (pending offline): that work stays parked.
      await this.deps.stillOnline(root.id, started).catch((err) =>
        this.deps.ctx.logger.warn({ err: (err as Error).message, scanRootId: root.id }, 'folder watch: could not send the parked work of a music folder online'),
      );
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

/** Dispatches released maintenance tasks after the commit; a failure is left to the app's dispatch loop. */
async function dispatchReleased(ctx: WorkerContext, tasks: string[]): Promise<void> {
  for (const id of tasks) {
    await dispatchMaintenanceTask(ctx.sql, maintenanceSender(ctx.boss), id).catch((err) =>
      ctx.logger.warn({ err: (err as Error).message, taskId: id }, 'folder watch: parked task left to the dispatch loop'),
    );
  }
}

/**
 * A root is back online (vault "tagave - Offline Library Spec", section 4
 * "Back online"): the gate takes work for it again; every parked job of the
 * root is sent again in one transaction with the deletes (parked maintenance
 * tasks released, then dispatched right after the commit: the attempt id
 * keeps it to one job); then exactly one scan of the root, singleton key
 * `scan:<root>`. Parked scan.root and scan.dir rows are not sent: the scan
 * covers them (ruling R14). It is full after not connected, or when a parked
 * scan.root asked for full; quick otherwise (files were not changing).
 * `before`: only rows parked before the reading that saw the return started.
 */
export function onlineAgain(ctx: WorkerContext): (rootId: string, after: 'offline' | 'unmounted', before?: Date) => Promise<void> {
  return async (rootId, after, before) => {
    fileGate().clear(rootId);
    const tasks: string[] = [];
    let failed: unknown = null;
    let fullScan = false;
    try {
      const out = await releaseParkedRows(ctx.sql, rootId, parkedSender(ctx.boss), { before, coverScans: true, onTask: (id) => tasks.push(id) });
      fullScan = out.fullScan;
      if (out.count > 0) ctx.logger.info({ scanRootId: rootId, released: out.count }, 'parked work sent again: music folder back online');
    } catch (err) {
      failed = err; // the rows stay: the next reading of online sends them (stillOnline)
    }
    await dispatchReleased(ctx, tasks);
    const mode = after === 'unmounted' || fullScan ? 'full' : 'quick';
    await ctx.boss.send('scan.root', { scanRootId: rootId, mode }, { singletonKey: `scan:${rootId}` });
    if (failed) throw failed;
  };
}

/**
 * A reading of online that is not a return (ruling R13): the gate takes work
 * for the root again, and work parked before the reading started is sent
 * again (scans included; no scan of its own). Quiet unless something went:
 * one info line then. A release that throws is tried again at the next reading.
 */
export function stillOnline(ctx: WorkerContext): (rootId: string, before: Date) => Promise<void> {
  return async (rootId, before) => {
    fileGate().clear(rootId);
    const tasks: string[] = [];
    const out = await releaseParkedRows(ctx.sql, rootId, parkedSender(ctx.boss), { before, onTask: (id) => tasks.push(id) });
    await dispatchReleased(ctx, tasks);
    if (out.count > 0) ctx.logger.info({ scanRootId: rootId, released: out.count }, 'parked work sent again: music folder online');
  };
}

let current: FolderWatch | null = null;

/**
 * Starts the file worker's watch: the one the park rule finds with
 * `folderWatch()`, and the process's file gate tells of a deadline or an
 * offline answer (ruling R18: registered here, not imported by the gate, so
 * there is no import cycle). `deps`: tests.
 */
export function startFolderWatch(ctx: WorkerContext, deps: Omit<FolderWatchDeps, 'ctx'> = {}): FolderWatch {
  current?.stop();
  const watch = new FolderWatch({ ...deps, ctx });
  current = watch;
  fileGate().setOnSuspect((rootId) => watch.suspect(rootId));
  watch.start();
  return watch;
}

export function folderWatch(): FolderWatch | null {
  return current;
}
