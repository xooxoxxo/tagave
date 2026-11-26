/**
 * One guarded look at a music root (vault "tagave - Offline Library Spec",
 * "Why the main process must not touch the share"). The worker's main
 * process never stats or opens the share: a forked child does, and the
 * parent can always give up on it. On the deadline the parent sends
 * SIGKILL, unrefs the child and closes the IPC channel, and never waits for
 * the child to exit: a child stuck in the kernel on a dead hard NFS share
 * may never exit, and it must not keep the parent's event loop alive.
 */
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { ProbeAnswer, ProbeRequest } from './probeChild.js';
import type { ProbeOutcome } from './reach.js';

const DEADLINE_MS = 15_000;
/** At most this many known files are asked about (the `checkMusicFolder` sample rule). */
export const MAX_KNOWN = 5;

/**
 * The built child. From dist it sits next to this file; from the sources
 * (tests, tsx) it is the built copy in the package's dist, so build first.
 */
function defaultChildPath(): string {
  const here = import.meta.url;
  const rel = here.endsWith('.js') ? './probeChild.js' : '../../../dist/lib/folderWatch/probeChild.js';
  return fileURLToPath(new URL(rel, here));
}

/** What the probe reads when the child fails without a usable answer: offline, never online. */
const CHILD_FAILED: ProbeOutcome = { kind: 'error', code: 'EPROBE' };

function isAnswer(msg: unknown): msg is ProbeAnswer {
  const m = msg as Record<string, unknown> | null;
  if (m === null || typeof m !== 'object') return false;
  if (m.ok === true) return typeof m.empty === 'boolean' && Number.isInteger(m.knownFound);
  if (m.ok === false) return typeof m.code === 'string' && m.code !== '';
  return false;
}

/** Lets go of the child without waiting on it. Safe to call on a child that already exited. */
function letGo(child: ChildProcess): void {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  child.unref();
  if (child.connected) child.disconnect();
}

/**
 * Forks the probe child on `dir` with the first 5 `known` paths (relative
 * to `dir`) and resolves exactly once: with its answer, with
 * `{ kind: 'deadline' }` after `deadlineMs` (15 s), or with an `EPROBE`
 * error when the child fails to start, closes without answering or answers
 * nonsense. A listing comes back with `knownAsked` (at most 5) and
 * `isMountPoint` and `wasMountPoint` false: the caller fills those from the
 * mount table. `stderr` is the child's stderr: the worker's by default,
 * `ignore` for tests that expect a child to crash.
 */
export function probeOnce(
  dir: string,
  known: string[],
  opts: { deadlineMs?: number; childPath?: string; stderr?: 'inherit' | 'ignore' } = {},
): Promise<ProbeOutcome> {
  const asked = known.slice(0, MAX_KNOWN);
  return new Promise<ProbeOutcome>((resolve) => {
    let child: ChildProcess;
    try {
      // The child is plain built JS: none of the parent's tsx or vitest flags.
      // Its stdout is not piped, so no stream of ours waits on it.
      child = fork(opts.childPath ?? defaultChildPath(), [], { execArgv: [], stdio: ['ignore', 'ignore', opts.stderr ?? 'inherit', 'ipc'], serialization: 'json' });
    } catch {
      resolve(CHILD_FAILED);
      return;
    }

    let settled = false;
    const finish = (outcome: ProbeOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('close', onEnd);
      child.off('error', onEnd);
      // Late events after we let go must not throw as unhandled 'error's.
      child.on('error', () => undefined);
      letGo(child);
      resolve(outcome);
    };
    const onMessage = (msg: unknown) => {
      if (!isAnswer(msg)) return finish(CHILD_FAILED);
      if (!msg.ok) return finish({ kind: 'error', code: msg.code });
      finish({ kind: 'listing', empty: msg.empty, knownFound: msg.knownFound, knownAsked: asked.length, isMountPoint: false, wasMountPoint: false });
    };
    // A spawn error's code (ENOENT for a missing node) is about the child, not
    // the share, so it must not read as a missing folder.
    const onEnd = () => finish(CHILD_FAILED);
    // 'close', not 'exit': 'exit' can come before the child's last message is
    // delivered, and a healthy root would read as failed. With an IPC channel,
    // 'close' comes after every message. A hung child never closes, and the
    // deadline covers it.
    const timer = setTimeout(() => finish({ kind: 'deadline' }), opts.deadlineMs ?? DEADLINE_MS);
    child.on('message', onMessage);
    child.once('close', onEnd);
    child.once('error', onEnd);

    const req: ProbeRequest = { dir, known: asked, realParentMount: false };
    try {
      child.send(req, (err) => {
        if (err) finish(CHILD_FAILED);
      });
    } catch {
      finish(CHILD_FAILED);
    }
  });
}
