/**
 * The folder watch's look at a music root, through the file gate (vault
 * "tagave - Offline Library Spec", "Why the main process must not touch the
 * share"). The worker's main process never stats or opens the share: the
 * gate's helpers do, and the gate gives up on one at its deadline.
 *
 * One probe of a root is one gate call at a time: `stat` of the root, the
 * first entry of its listing (`readdirPage`, limit 1), then a `stat` of each
 * known file. Each call is a probe (`{ probe: true }`): it passes the gate's
 * stuck cap, and reads a deadline at once while the root's last probe helper
 * is still stuck, so stuck helpers never pile up (PR1's ruling, now the
 * gate's).
 */
import path from 'node:path';
import type { FileGate } from '../fileGate.js';
import type { DirPage } from '../fileHelper.js';
import { FolderOfflineError } from '../folderOffline.js';
import type { ProbeOutcome } from './reach.js';

/** At most this many known files are asked about (the `checkMusicFolder` sample rule). */
export const MAX_KNOWN = 5;

/** A known path that is gone is not found; any other error fails the probe. */
const GONE = new Set(['ENOENT', 'ENOTDIR']);

const PROBE = { probe: true } as const;

function codeOf(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code !== '' ? code : 'EPROBE';
}

/**
 * What a failed gate call reads as: a deadline (the gate gave up), or the
 * error code (an offline code from the share, ENOENT for a missing root, or
 * EHELPER for a helper that failed). `classify` in reach.ts maps it.
 */
function failed(err: unknown): ProbeOutcome {
  if (err instanceof FolderOfflineError) return err.code ? { kind: 'error', code: err.code } : { kind: 'deadline' };
  return { kind: 'error', code: codeOf(err) };
}

/**
 * Looks at `dir` for the root `rootId` with the first 5 `known` paths
 * (relative to `dir`). A listing comes back with `knownAsked` (at most 5)
 * and `isMountPoint` and `wasMountPoint` false: the caller fills those from
 * the mount table.
 */
export async function gateProbe(gate: Pick<FileGate, 'run'>, rootId: string, dir: string, known: string[]): Promise<ProbeOutcome> {
  const asked = known.slice(0, MAX_KNOWN);
  try {
    await gate.run(rootId, { op: 'stat', path: dir }, PROBE);
    const page = await gate.run<DirPage>(rootId, { op: 'readdirPage', path: dir, limit: 1 }, PROBE);
    let found = 0;
    for (const rel of asked) {
      try {
        await gate.run(rootId, { op: 'stat', path: path.join(dir, rel) }, PROBE);
        found += 1;
      } catch (err) {
        if (err instanceof FolderOfflineError || !GONE.has(codeOf(err))) throw err;
      }
    }
    return { kind: 'listing', empty: page.entries.length === 0, knownFound: found, knownAsked: asked.length, isMountPoint: false, wasMountPoint: false };
  } catch (err) {
    return failed(err);
  }
}
