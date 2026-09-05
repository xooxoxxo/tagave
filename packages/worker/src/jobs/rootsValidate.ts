import { access, opendir, stat } from 'node:fs/promises';
import { eq, and } from 'drizzle-orm';
import { scanRoots } from '@liner/db';
import type { WorkerContext } from '../lib/context.js';

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
 * mounts fail access(2) with EROFS).
 */
export async function probeRoot(rootPath: string, writableIntent: boolean): Promise<RootProbe> {
  let err: NodeJS.ErrnoException | null = null;
  let isDirectory: boolean | null = null;
  try {
    isDirectory = (await stat(rootPath)).isDirectory();
    if (isDirectory) {
      const d = await opendir(rootPath);
      await d.close();
    }
  } catch (e) {
    err = e as NodeJS.ErrnoException;
  }
  const { status, message } = classifyProbe(err, isDirectory);
  if (status !== 'ok') return { status, message: message ?? null, probeWritable: null };
  let probeWritable = true;
  let msg: string | null = message ?? null;
  try {
    await access(rootPath, 2); // W_OK
  } catch {
    probeWritable = false;
    if (writableIntent) msg = 'mounted read-only';
  }
  return { status: 'ok', message: msg, probeWritable };
}

/**
 * spec LIB-1: Validate scan roots by probing on the worker host.
 * Roots probe stat → classification → update validation columns.
 * When writable intent is true but probe_writable is false, status stays 'ok' with read-only message.
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
    const { status, message: validationMessage, probeWritable } = await probeRoot(root.path, root.writable);

    // Update the root's validation columns
    await ctx.db
      .update(scanRoots)
      .set({
        validationStatus: status,
        validationMessage,
        validatedAt: new Date(),
        probeWritable,
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
