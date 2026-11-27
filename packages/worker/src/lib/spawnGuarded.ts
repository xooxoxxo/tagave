/**
 * Child tools on music files (fpcalc, ffmpeg, flac, metaflac) with the file
 * gate's deadlines (vault "tagave - Offline Library Spec"). A tool reading a
 * file on a dead hard NFS share blocks in the kernel; this gives up on it.
 *
 * `waitMs` is a deadline for the whole run; `idleMs` is reset by any bytes on
 * stdout or stderr. On a deadline: SIGKILL, unref the child and close its
 * pipes, never wait for it to exit, count it stuck for the root
 * (`fileGate().markStuck`, which also tells the watch) and throw
 * FolderOfflineError(rootId, 'timeout'). Spawning touches nothing on the
 * share: paths are only arguments.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { setPriority } from 'node:os';
import { fileGate, gateLimits } from './fileGate.js';
import { FolderOfflineError } from './folderOffline.js';

export interface GuardedResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
}

export interface GuardedOptions {
  /** The scan root the tool's file is under: a deadline counts against it. */
  rootId: string;
  /** Deadline for the whole run. */
  waitMs?: number;
  /** Deadline between two writes on stdout or stderr. Without either deadline: the gate's idle deadline. */
  idleMs?: number;
  /** Written to the tool's stdin, which is then closed. */
  input?: Buffer;
  /** Most stdout to keep: past it the tool is killed and the result has code -1. */
  maxStdout?: number;
  /** Takes stdout as it comes instead of collecting it. A throw kills the tool and rejects with that error. */
  onStdout?: (chunk: Buffer) => void;
  /** A lower CPU priority for the tool, where allowed. */
  nice?: number;
}

/** How much of stderr is kept: the last lines say why a tool failed. */
const STDERR_TAIL = 8192;

/** Lets go of a child without waiting on it. Safe on one that already exited. */
function letGo(child: ChildProcess): void {
  // Late events after we let go must not throw as unhandled 'error's.
  child.on('error', () => undefined);
  child.stdin?.on('error', () => undefined);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  child.unref();
  child.stdin?.destroy();
  child.stdout?.destroy();
  child.stderr?.destroy();
}

export function spawnGuarded(bin: string, args: readonly string[], opts: GuardedOptions): Promise<GuardedResult> {
  // A root at its stuck cap gets no more work, as in the gate: no more children to pile up in the kernel.
  if (fileGate().stuckCount(opts.rootId) >= gateLimits().stuckMax) return Promise.reject(new FolderOfflineError(opts.rootId, 'timeout'));
  return new Promise<GuardedResult>((resolve, reject) => {
    const child = spawn(bin, [...args], { stdio: [opts.input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    const idleMs = opts.idleMs ?? (opts.waitMs === undefined ? gateLimits().idleMs : undefined);
    const out: Buffer[] = [];
    let size = 0;
    let over = false;
    let stderr = '';
    let done = false;
    let idleTimer: NodeJS.Timeout | null = null;
    let waitTimer: NodeJS.Timeout | null = null;

    const finish = (): boolean => {
      if (done) return false;
      done = true;
      if (idleTimer) clearTimeout(idleTimer);
      if (waitTimer) clearTimeout(waitTimer);
      return true;
    };
    const giveUp = () => {
      if (!finish()) return;
      letGo(child);
      fileGate().markStuck(opts.rootId);
      reject(new FolderOfflineError(opts.rootId, 'timeout'));
    };
    const stop = (err: unknown) => {
      if (!finish()) return;
      letGo(child);
      reject(err);
    };
    const armIdle = () => {
      if (done || idleMs === undefined) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(giveUp, idleMs);
    };
    if (opts.waitMs !== undefined) waitTimer = setTimeout(giveUp, opts.waitMs);
    armIdle();

    if (opts.nice !== undefined && child.pid) {
      try {
        setPriority(child.pid, opts.nice);
      } catch {
        // not allowed here (some containers): it runs at the normal priority
      }
    }

    child.stdout!.on('data', (d: Buffer) => {
      armIdle();
      if (done || over) return;
      if (opts.onStdout) {
        try {
          opts.onStdout(d);
        } catch (err) {
          stop(err);
        }
        return;
      }
      size += d.length;
      if (opts.maxStdout !== undefined && size > opts.maxStdout) {
        over = true;
        out.length = 0;
        child.kill('SIGKILL');
        return;
      }
      out.push(d);
    });
    child.stderr!.on('data', (d: Buffer) => {
      armIdle();
      stderr = (stderr + d.toString()).slice(-STDERR_TAIL);
    });
    child.on('error', (err) => stop(err));
    child.on('close', (code) => {
      if (!finish()) return;
      resolve({ code: over ? -1 : code, stdout: Buffer.concat(out), stderr });
    });
    if (opts.input && child.stdin) {
      // A tool may stop reading early (fpcalc once it has -length seconds): EPIPE is fine.
      child.stdin.on('error', () => undefined);
      child.stdin.end(opts.input);
    }
  });
}
