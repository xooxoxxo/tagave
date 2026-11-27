/**
 * The file gate (vault "tagave - Offline Library Spec", "Why the main
 * process must not touch the share"). Every file call the worker makes on a
 * music share goes through here, to a small pool of forked helpers. On a dead
 * hard NFS share a file call can block in the kernel for good and hold one of
 * libuv's four threads; in a helper it holds only that helper, and the gate
 * can give up on it.
 *
 * Each op has a deadline: `waitMs` (15 s) for metadata calls, and an idle
 * deadline `idleMs` (60 s) for the long reads and writes, reset by each
 * `{ progress }` message the helper sends. On a deadline the gate sends
 * SIGKILL, unrefs the helper and closes its IPC channel without waiting for
 * it to exit, counts it stuck for the op's root, forks a fresh helper, tells
 * the watch (`onSuspect`) and throws FolderOfflineError(root, 'timeout'). An
 * offline error code from the share also tells the watch, without counting
 * the helper stuck. A helper answer marked `stuck` (its tag writer's sidecar
 * hung) counts stuck and throws FolderOfflineError, keeping the helper. A
 * root with `stuckMax` stuck helpers gets no more work until `clear(root)`.
 *
 * Probes (`run(root, op, { probe: true })`, the folder watch's look at a
 * root) pass that cap, or a root at the cap could never read online again,
 * and go ahead of queued work. While the root's last probe helper that hit
 * a deadline has not exited (stuck in the kernel), a probe reads the
 * deadline at once and forks nothing, so stuck probe helpers never pile up.
 */
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { WriteOptions } from '@tagave/core';
import type { TagSet } from '@tagave/shared';
import { classify } from './folderWatch/reach.js';
import { FolderOfflineError, OFFLINE_CODES } from './folderOffline.js';

export type GateOp =
  | { op: 'stat' | 'lstat' | 'access' | 'realpath' | 'unlink' | 'rmdir' | 'statfs'; path: string; mode?: number; bigint?: boolean }
  | { op: 'readdirPage'; path: string; cursor?: string | null; limit?: number /* 500 */ }
  | { op: 'mkdir'; path: string; recursive?: boolean }
  | { op: 'rename'; from: string; to: string }
  | { op: 'readSmall'; path: string; maxBytes?: number /* 32 MB */ }
  | { op: 'parse' | 'contentHash'; handlerId: string; path: string }
  | { op: 'cover'; handlerId: string; path: string; metadata: unknown }
  | { op: 'parseAudio'; path: string; options?: { duration?: boolean; skipCovers?: boolean } }
  | { op: 'writeTagged'; path: string; handlerId: string; values: TagSet; options?: WriteOptions };

export interface GateLimits {
  /** The deadline for a metadata op. */
  waitMs: number;
  /** The deadline for a long op between two progress messages. */
  idleMs: number;
  /** How many helpers run at once (TAGAVE_FILE_HELPERS). */
  helpers: number;
  /** Stuck helpers for one root before it gets no more work (TAGAVE_FILE_HELPERS_STUCK_MAX). */
  stuckMax: number;
}

/** A request to a helper. */
export interface HelperRequest {
  id: number;
  /** The root the op's path is under. */
  rootId?: string;
  op: GateOp;
}

/** What a helper sends back for a request: progress while it works, then one answer. */
export type HelperMessage =
  | { id: number; progress: unknown }
  | { id: number; ok: true; value: unknown }
  /** `stuck`: the helper gave up on a child of its own (the tag writer's sidecar) at a deadline. */
  | { id: number; ok: false; code?: string; message?: string; stuck?: boolean; /** the error's class name, kept for callers that store it (a parse error) */ name?: string };

/** Ops that read or write a whole file: they use the idle deadline, reset by progress. */
const IDLE_OPS = new Set<GateOp['op']>(['parse', 'contentHash', 'cover', 'parseAudio', 'readSmall', 'writeTagged']);

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return raw !== undefined && raw.trim() !== '' && Number.isInteger(n) && n > 0 ? n : fallback;
}

/** The default limits, with the helper counts from the environment. */
export function gateLimits(env: Record<string, string | undefined> = process.env): GateLimits {
  return {
    waitMs: 15_000,
    idleMs: 60_000,
    helpers: positiveInt(env.TAGAVE_FILE_HELPERS, 2),
    stuckMax: positiveInt(env.TAGAVE_FILE_HELPERS_STUCK_MAX, 4),
  };
}

/**
 * The built helper. From dist it sits next to this file; from the sources
 * (tests, tsx) it is the built copy in the package's dist, so build first.
 */
function defaultHelperPath(): string {
  const here = import.meta.url;
  const rel = here.endsWith('.js') ? './fileHelper.js' : '../../dist/lib/fileHelper.js';
  return fileURLToPath(new URL(rel, here));
}

/** An error for a helper that failed without an answer: about the helper, not the share. */
function helperFailed(message: string): Error {
  return Object.assign(new Error(message), { code: 'EHELPER' });
}

/** Lets go of a helper without waiting on it. Safe on a helper that already exited. */
function letGo(child: ChildProcess): void {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  child.unref();
  if (child.connected) child.disconnect();
}

function exited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

export interface RunOptions {
  /** The folder watch's probe: passes the stuck cap, and goes ahead of queued work. */
  probe?: boolean;
}

interface Job {
  id: number;
  rootId: string;
  op: GateOp;
  probe: boolean;
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
}

interface Helper {
  child: ChildProcess;
  job: Job | null;
  timer: NodeJS.Timeout | null;
}

export class FileGate {
  private readonly limits: GateLimits;
  private readonly helperPath: string;
  private readonly onSuspect: (rootId: string) => void;
  private readonly helpers = new Set<Helper>();
  private readonly queue: Job[] = [];
  private readonly stuck = new Map<string, number>();
  /** Helpers let go of that may still be running: close() gives them a moment to exit. */
  private readonly abandoned = new Set<ChildProcess>();
  /** Per root, the probe helper let go of at a deadline that has not exited yet. */
  private readonly heldProbe = new Map<string, ChildProcess>();
  private nextId = 1;
  private closed = false;

  constructor(opts: { limits?: Partial<GateLimits>; helperPath?: string; onSuspect?: (rootId: string) => void } = {}) {
    this.limits = { ...gateLimits(), ...opts.limits };
    this.helperPath = opts.helperPath ?? defaultHelperPath();
    this.onSuspect = opts.onSuspect ?? (() => undefined);
  }

  /** Runs one operation for a file under this root. Throws FolderOfflineError on a deadline or an offline errno; other fs errors come back as Error with their code. */
  run<T>(rootId: string, op: GateOp, opts: RunOptions = {}): Promise<T> {
    if (this.closed) return Promise.reject(new Error('The file gate is closed'));
    const probe = opts.probe === true;
    const refused = this.refusal(rootId, probe);
    if (refused) return Promise.reject(refused);
    return new Promise<T>((resolve, reject) => {
      const job: Job = { id: this.nextId++, rootId, op, probe, resolve: resolve as (value: unknown) => void, reject };
      if (probe) this.queue.unshift(job);
      else this.queue.push(job);
      this.pump();
    });
  }

  /** The root is online again: its work may be sent. */
  clear(rootId: string): void {
    this.stuck.delete(rootId);
  }

  /** Stuck helpers (and child tools) counted for this root, or for all roots. */
  stuckCount(rootId?: string): number {
    if (rootId !== undefined) return this.stuck.get(rootId) ?? 0;
    let total = 0;
    for (const n of this.stuck.values()) total += n;
    return total;
  }

  /** True when work for this root is refused now (its stuck cap): spawnGuarded asks before it spawns. */
  refuses(rootId: string): boolean {
    return this.refusal(rootId, false) !== null;
  }

  /** A child process for this root got stuck outside the gate (spawnGuarded): it counts like a stuck helper. */
  markStuck(rootId: string): void {
    this.stuck.set(rootId, this.stuckCount(rootId) + 1);
    this.suspect(rootId);
  }

  /** Tells the watch the root may be offline. A throwing listener must not break the gate. */
  private suspect(rootId: string): void {
    try {
      this.onSuspect(rootId);
    } catch {
      // The watch's trouble, not the caller's: the call already settled.
    }
  }

  /** Lets go of every helper, fails the work in flight and queued, and refuses new work. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const closedErr = () => new Error('The file gate is closed');
    for (const job of this.queue.splice(0)) job.reject(closedErr());
    const children: ChildProcess[] = [...this.abandoned];
    for (const h of [...this.helpers]) {
      if (h.timer) clearTimeout(h.timer);
      h.job?.reject(closedErr());
      h.job = null;
      this.helpers.delete(h);
      children.push(h.child);
      letGo(h.child);
    }
    // Give the helpers a moment to exit, never more: one stuck in the kernel may never.
    await Promise.all(children.filter((c) => !exited(c)).map((c) => waitExit(c, 1_000)));
  }

  /**
   * Why work for this root may not be sent now, or null. The one place the
   * refusal is decided, both when a call comes in and when it leaves the
   * queue. A probe passes the stuck cap, but not a probe helper of the root
   * still stuck from its last deadline.
   */
  private refusal(rootId: string, probe: boolean): FolderOfflineError | null {
    if (probe) return this.heldProbe.has(rootId) ? new FolderOfflineError(rootId, 'timeout') : null;
    return this.stuckCount(rootId) >= this.limits.stuckMax ? new FolderOfflineError(rootId, 'timeout') : null;
  }

  /** Sends queued work to free helpers, forking helpers up to the limit. */
  private pump(): void {
    while (!this.closed && this.queue.length > 0) {
      let free: Helper | undefined;
      for (const h of this.helpers) {
        if (h.job === null) {
          free = h;
          break;
        }
      }
      if (!free && this.helpers.size < this.limits.helpers) free = this.spawn();
      if (!free) return;
      const job = this.queue.shift()!;
      const refused = this.refusal(job.rootId, job.probe);
      if (refused) {
        job.reject(refused);
        continue;
      }
      this.send(free, job);
    }
  }

  private spawn(): Helper {
    // The helper is plain built JS: none of the parent's tsx or vitest flags.
    // 'advanced' serialization so Buffers and BigInts pass.
    const child = fork(this.helperPath, [], { execArgv: [], stdio: ['ignore', 'ignore', 'inherit', 'ipc'], serialization: 'advanced' });
    const h: Helper = { child, job: null, timer: null };
    this.helpers.add(h);
    child.on('message', (msg: unknown) => this.onMessage(h, msg));
    // 'close', not 'exit': with an IPC channel it comes after every message.
    child.once('close', () => this.onGone(h));
    child.on('error', () => this.onGone(h));
    this.idle(h);
    return h;
  }

  private send(h: Helper, job: Job): void {
    h.job = job;
    h.child.ref();
    (h.child.channel as { ref?: () => void } | null | undefined)?.ref?.();
    this.arm(h);
    const req: HelperRequest = { id: job.id, rootId: job.rootId, op: job.op };
    try {
      h.child.send(req, (err) => {
        if (err && h.job === job) this.fail(h, helperFailed(`The file helper did not take the request: ${err.message}`));
      });
    } catch (err) {
      this.fail(h, helperFailed(`The file helper did not take the request: ${(err as Error).message}`));
    }
  }

  /** Starts (or restarts) the deadline for the helper's job. */
  private arm(h: Helper): void {
    if (h.timer) clearTimeout(h.timer);
    const job = h.job;
    if (!job) return;
    const ms = IDLE_OPS.has(job.op.op) ? this.limits.idleMs : this.limits.waitMs;
    h.timer = setTimeout(() => this.deadline(h, job), ms);
  }

  private onMessage(h: Helper, msg: unknown): void {
    const job = h.job;
    const m = msg as Record<string, unknown> | null;
    if (!job || m === null || typeof m !== 'object' || m.id !== job.id) return;
    if ('progress' in m) {
      if (IDLE_OPS.has(job.op.op)) this.arm(h);
      return;
    }
    if (m.ok === true) return this.settle(h, () => job.resolve(m.value));
    if (m.ok === false) {
      if (m.stuck === true) {
        // A child of the helper hung on the share (the tag writer's sidecar): it counts like a stuck helper.
        // The helper itself answered, so it stays and takes the next op.
        this.markStuck(job.rootId);
        return this.settle(h, () => job.reject(new FolderOfflineError(job.rootId, 'timeout')));
      }
      const code = typeof m.code === 'string' && m.code !== '' ? m.code : undefined;
      if (code && OFFLINE_CODES.has(code)) {
        const reason = classify({ kind: 'error', code }).reason ?? 'io_error';
        // The share answered, so the helper is not stuck; the watch should still look.
        this.settle(h, () => job.reject(new FolderOfflineError(job.rootId, reason, code)));
        return this.suspect(job.rootId);
      }
      const message = typeof m.message === 'string' && m.message !== '' ? m.message : `${job.op.op} failed`;
      const err = code ? Object.assign(new Error(message), { code }) : new Error(message);
      if (typeof m.name === 'string' && m.name !== '' && m.name !== 'Error') err.name = m.name;
      return this.settle(h, () => job.reject(err));
    }
    this.fail(h, helperFailed('The file helper sent a message it should not have'));
  }

  /** The job is done; the helper takes the next one. */
  private settle(h: Helper, done: () => void): void {
    if (h.timer) clearTimeout(h.timer);
    h.timer = null;
    h.job = null;
    done();
    this.idle(h);
    this.pump();
  }

  /** An idle helper must not keep the process alive. */
  private idle(h: Helper): void {
    if (h.job !== null) return;
    h.child.unref();
    (h.child.channel as { unref?: () => void } | null | undefined)?.unref?.();
  }

  /** The helper is not usable any more: drop it, fail its job, and carry on with a fresh one. */
  private fail(h: Helper, err: Error): void {
    const job = this.drop(h);
    job?.reject(err);
    this.pump();
  }

  /** The helper exited or errored on its own. */
  private onGone(h: Helper): void {
    if (!this.helpers.has(h)) return;
    this.fail(h, helperFailed('The file helper stopped without an answer'));
  }

  private deadline(h: Helper, job: Job): void {
    if (h.job !== job || !this.helpers.has(h)) return;
    this.drop(h);
    if (job.probe && !exited(h.child)) {
      // The next probe of this root reads a deadline at once until this helper is gone.
      const child = h.child;
      this.heldProbe.set(job.rootId, child);
      child.once('exit', () => {
        if (this.heldProbe.get(job.rootId) === child) this.heldProbe.delete(job.rootId);
      });
    }
    this.stuck.set(job.rootId, this.stuckCount(job.rootId) + 1);
    // A fresh helper in its place, ready for the next call.
    if (!this.closed && this.helpers.size < this.limits.helpers) this.spawn();
    job.reject(new FolderOfflineError(job.rootId, 'timeout'));
    this.pump();
    this.suspect(job.rootId);
  }

  /** Removes the helper from the pool and lets go of it, never waiting. Returns the job it had. */
  private drop(h: Helper): Job | null {
    if (h.timer) clearTimeout(h.timer);
    h.timer = null;
    const job = h.job;
    h.job = null;
    this.helpers.delete(h);
    // Late events after we let go must not throw as unhandled 'error's.
    h.child.on('error', () => undefined);
    if (!exited(h.child)) {
      this.abandoned.add(h.child);
      h.child.once('exit', () => this.abandoned.delete(h.child));
    }
    letGo(h.child);
    return job;
  }
}

/** Resolves when the child exits, or after `ms`, whichever comes first. */
function waitExit(child: ChildProcess, ms: number): Promise<void> {
  return new Promise<void>((done) => {
    const timer = setTimeout(done, ms);
    timer.unref();
    child.once('exit', () => {
      clearTimeout(timer);
      done();
    });
  });
}

let processGate: FileGate | null = null;

/** The process's one gate, made on first use. */
export function fileGate(): FileGate {
  processGate ??= new FileGate();
  return processGate;
}

/** Tests: puts a gate of their own in place of the process's one (null: the next call makes a fresh one). */
export function setFileGate(gate: FileGate | null): void {
  processGate = gate;
}
