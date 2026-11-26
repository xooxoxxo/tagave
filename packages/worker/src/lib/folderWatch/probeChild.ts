/**
 * The child that touches the music share for `probeOnce`. On a dead hard
 * NFS share any fs call here can block in the kernel for good; that is why
 * it runs in its own process, which the parent kills and lets go of.
 *
 * It takes one message `{ dir, known, realParentMount }` on its IPC
 * channel, where `known` are paths relative to `dir`. It does `stat(dir)`,
 * reads the first entry of `dir`, and `stat`s each known path. It sends one
 * answer and exits. A known path that is gone (ENOENT, ENOTDIR) is not
 * found; any other error fails the whole probe with its code.
 */
import { opendir, stat } from 'node:fs/promises';
import { join } from 'node:path';

export interface ProbeRequest {
  dir: string;
  known: string[];
  /** Whether `dir` is seen through the parent bind. Carried for the caller; the probe does the same calls either way. */
  realParentMount: boolean;
}

export type ProbeAnswer = { ok: true; empty: boolean; knownFound: number } | { ok: false; code: string };

const GONE = new Set(['ENOENT', 'ENOTDIR']);

function codeOf(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code !== '' ? code : 'EPROBE';
}

async function knownExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if (GONE.has(codeOf(err))) return false;
    throw err;
  }
}

export async function probe(req: ProbeRequest): Promise<ProbeAnswer> {
  try {
    await stat(req.dir);
    const handle = await opendir(req.dir);
    let empty: boolean;
    try {
      empty = (await handle.read()) === null;
    } finally {
      await handle.close().catch(() => undefined);
    }
    const found = await Promise.all(req.known.map((rel) => knownExists(join(req.dir, rel))));
    return { ok: true, empty, knownFound: found.filter(Boolean).length };
  } catch (err) {
    return { ok: false, code: codeOf(err) };
  }
}

function isRequest(msg: unknown): msg is ProbeRequest {
  const m = msg as Partial<ProbeRequest> | null;
  return typeof m?.dir === 'string' && Array.isArray(m.known) && m.known.every((k) => typeof k === 'string');
}

// Run only as a forked child: importing this module elsewhere does nothing.
if (process.send) {
  process.once('message', (msg: unknown) => {
    const answer: Promise<ProbeAnswer> = isRequest(msg) ? probe(msg) : Promise.resolve({ ok: false, code: 'EPROBE' });
    void answer.then((a) => process.send?.(a, () => process.exit(0)));
  });
  // The parent gave up on us: leave, if the kernel lets us.
  process.once('disconnect', () => process.exit(0));
}
