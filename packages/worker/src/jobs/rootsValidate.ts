import { eq, and } from 'drizzle-orm';
import { rootReach, scanRoots } from '@tagave/db';
import { SCAN_ROOT_EMPTY_MESSAGE } from '@tagave/shared';
import type { WorkerContext } from '../lib/context.js';
import { fileGate } from '../lib/fileGate.js';
import type { DirPage } from '../lib/fileHelper.js';
import { FolderOfflineError, isGateFailure } from '../lib/folderOffline.js';
import { inContainer } from '../lib/localFiles.js';

export interface RootsValidateJobData {
  scanRootId?: string;
  libraryId?: string;
}

export type ValidationStatus = 'pending' | 'ok' | 'missing' | 'not_directory' | 'unreadable';

/**
 * spec LIB-1: pure classification of probe result for testability.
 * err: stat/opendir error or null if ok
 * isDirectory: true if path is a directory (from stat.isDirectory()), null if stat failed
 * Returns: validation status and optional message
 */
export function classifyProbe(
  err: NodeJS.ErrnoException | null,
  isDirectory: boolean | null,
): { status: ValidationStatus; message?: string } {
  if (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { status: 'missing', message: 'Path does not exist' };
    }
    if (code === 'ENOTDIR') {
      return { status: 'not_directory', message: 'Path component is not a directory' };
    }
    return { status: 'unreadable', message: `Cannot read directory: ${err.message}` };
  }

  if (!isDirectory) {
    return { status: 'not_directory', message: 'Path is not a directory' };
  }

  return { status: 'ok' };
}

export interface RootProbe {
  status: ValidationStatus;
  message: string | null;
  probeWritable: boolean | null;
}

/**
 * spec LIB-1/LIB-5: one probe used by roots.validate and by scan.root before
 * it touches anything. stat → must be a directory → opendir (a dir that
 * exists but cannot be read is 'unreadable', not 'ok') → W_OK (read-only
 * mounts fail access(2) with EROFS). Every call goes through the file gate
 * for the root `rootId`; an offline folder (a gate deadline or an offline
 * error code) throws FolderOfflineError, so the caller parks instead of
 * stamping a verdict on a folder it could not see.
 */
export async function probeRoot(rootPath: string, writableIntent: boolean, rootId: string): Promise<RootProbe> {
  const gate = fileGate();
  let err: NodeJS.ErrnoException | null = null;
  let isDirectory: boolean | null = null;
  let empty = false;
  try {
    isDirectory = (await gate.run<{ isDirectory: boolean }>(rootId, { op: 'stat', path: rootPath })).isDirectory;
    if (isDirectory) empty = (await gate.run<DirPage>(rootId, { op: 'readdirPage', path: rootPath, limit: 1 })).entries.length === 0;
  } catch (e) {
    // offline, or the gate failed: no verdict on a folder it could not see
    if (e instanceof FolderOfflineError || isGateFailure(e)) throw e;
    err = e as NodeJS.ErrnoException;
  }
  const { status, message } = classifyProbe(err, isDirectory);
  if (status !== 'ok') return { status, message: message ?? null, probeWritable: null };
  let probeWritable = true;
  let msg: string | null = message ?? null;
  try {
    await gate.run(rootId, { op: 'access', path: rootPath, mode: 2 }); // W_OK
  } catch (e) {
    if (e instanceof FolderOfflineError || isGateFailure(e)) throw e;
    probeWritable = false;
    if (writableIntent) msg = 'mounted read-only';
  }
  // An empty root outranks read-only: it usually means the mount is wrong
  // (a folder Docker does not share shows up empty), and every scan of it
  // finds nothing.
  if (empty) msg = SCAN_ROOT_EMPTY_MESSAGE;
  return { status: 'ok', message: msg, probeWritable };
}

/** Where compose mounts the music in the file worker (deploy/compose.yml). */
export const MUSIC_MOUNT = '/mnt/music';

/**
 * Where a scan root is on the computer that holds the music, for the Marked
 * list's delete command (0073 scan_roots.host_path). Compose passes the host
 * folder it mounts at /mnt/music as TAGAVE_MUSIC_HOST_DIR (filled from
 * MUSIC_DIR, which the installer always writes), so a root at or under the
 * mount maps onto it. Outside a container the root's path is the host's
 * path. Otherwise (a container without the variable, a root mounted some
 * other way) it is not known: null.
 */
export function hostPathFor(
  rootPath: string,
  env: { hostDir?: string | undefined; mount?: string | undefined; inContainer: boolean },
): string | null {
  const mount = (env.mount || MUSIC_MOUNT).replace(/\/+$/, '');
  const hostDir = env.hostDir?.trim().replace(/\/+$/, '');
  const root = rootPath.replace(/\/+$/, '') || '/';
  if (hostDir && hostDir.startsWith('/') && (root === mount || root.startsWith(mount + '/'))) {
    return hostDir + root.slice(mount.length);
  }
  return env.inContainer ? null : root;
}

/** hostPathFor with this process's environment. */
export async function hostPathHere(rootPath: string): Promise<string | null> {
  return hostPathFor(rootPath, {
    hostDir: process.env['TAGAVE_MUSIC_HOST_DIR'],
    mount: process.env['TAGAVE_MUSIC_MOUNT'],
    inContainer: await inContainer(),
  });
}

/**
 * spec LIB-1: Validate scan roots by probing on the worker host.
 * Roots probe stat → classification → update validation columns.
 * When writable intent is true but probe_writable is false, status stays 'ok' with read-only message.
 * A root that is not online (offline or not connected; unknown, before the
 * watch's first reading, is probed) is skipped, and so is one that goes
 * offline during its probe: its validation columns stay as they are.
 */
export async function rootsValidateJob(ctx: WorkerContext, data: RootsValidateJobData): Promise<void> {
  const where = [];
  if (data.scanRootId) {
    where.push(eq(scanRoots.id, data.scanRootId));
  }
  if (data.libraryId) {
    where.push(eq(scanRoots.libraryId, data.libraryId));
  }

  const query = where.length > 0
    ? ctx.db.select().from(scanRoots).where(and(...where))
    : ctx.db.select().from(scanRoots);

  const roots = await query;

  for (const root of roots) {
    const { reach } = await rootReach(ctx.sql, root.id);
    if (reach !== 'online' && reach !== 'unknown') {
      ctx.logger.info({ scanRootId: root.id, reach }, 'scan root not validated: music folder offline');
      continue;
    }
    let probe: RootProbe;
    try {
      probe = await probeRoot(root.path, root.writable, root.id);
    } catch (err) {
      if (!(err instanceof FolderOfflineError)) throw err;
      ctx.logger.info({ scanRootId: root.id, reason: err.reason }, 'scan root not validated: music folder offline');
      continue;
    }
    const { status, message: validationMessage, probeWritable } = probe;

    // Update the root's validation columns
    await ctx.db
      .update(scanRoots)
      .set({
        validationStatus: status,
        validationMessage,
        validatedAt: new Date(),
        probeWritable,
        hostPath: await hostPathHere(root.path),
      })
      .where(eq(scanRoots.id, root.id));

    ctx.logger.info(
      {
        scanRootId: root.id,
        path: root.path,
        validationStatus: status,
        probeWritable,
        validationMessage,
      },
      'scan root validated',
    );
  }
}
