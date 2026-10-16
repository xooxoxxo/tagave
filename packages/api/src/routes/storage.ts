/**
 * Settings › Storage: disk use of everything tagave keeps (database groups,
 * the cache and backups folders) and the cleanup of finished tag changes.
 * Owner only: it names paths and covers every library.
 *
 * A measurement that fails says what failed: 503 when the database cannot
 * be reached, 500 naming the step otherwise. The page used to blame
 * permissions for every error, also while the database was down.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  PROBLEM_TYPES,
  tagChangeCleanupRequestSchema,
  type StorageFolderView,
  type StorageOverview,
  type StorageProblem,
  type StorageStep,
  type TagChangeCleanupScope,
} from '@tagave/shared';
import { diskSpace } from '@tagave/doctor';
import { getDb } from '../db.js';
import { databaseUnreachable } from '../lib/databaseUnreachable.js';
import { ApiError } from '../middleware/errorHandler.js';
import {
  databaseUsage,
  folderUsage,
  isInside,
  previewTagChangeCleanup,
  runTagChangeCleanup,
} from '../lib/storageUsage.js';

export interface StorageRoutesOptions {
  /** The backups folder (BackupService.dir). */
  backupDir: string;
  /** CACHE_DIR; undefined when not set. */
  cacheDir?: string | undefined;
}

function requireOwner(request: FastifyRequest): string {
  if (!request.user) throw new ApiError(401, 'Unauthorized', 'Authentication required');
  if (request.user.role !== 'owner') throw new ApiError(403, 'Forbidden', 'Only the owner can see storage');
  return request.user.id;
}

/** A failure while measuring one part, with what that part was. */
export class StorageStepError extends Error {
  constructor(readonly step: StorageStep, readonly what: string, readonly cause: unknown) {
    super(`Measuring ${what} failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'StorageStepError';
  }
}

async function measure<T>(step: StorageStep, what: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    throw new StorageStepError(step, what, err);
  }
}

/** The answer for a failed GET /storage; null leaves `err` to the error handler. */
export function storageProblem(err: unknown): StorageProblem | null {
  const step = err instanceof StorageStepError ? err.step : undefined;
  // Only the database step can blame the database: an NFS cache or backups
  // folder that times out is a measurement failure of that folder.
  const down = step === undefined || step === 'database' ? databaseUnreachable(err instanceof StorageStepError ? err.cause : err) : null;
  if (down) {
    return {
      type: PROBLEM_TYPES.databaseUnreachable,
      title: 'Database unreachable',
      status: 503,
      detail: `The database cannot be reached: ${down}. Check that the postgres container runs (docker compose ps postgres) and read its log (docker compose logs postgres); a full disk stops it.`,
      ...(step ? { step } : {}),
    };
  }
  if (err instanceof StorageStepError) {
    return { type: PROBLEM_TYPES.storageMeasurementFailed, title: 'Measurement failed', status: 500, detail: err.message, step: err.step };
  }
  return null;
}

function scopeOf(raw: unknown): TagChangeCleanupScope {
  if (raw === undefined || raw === 'archived') return 'archived';
  if (raw === 'finished') return 'finished';
  throw new ApiError(400, 'Bad Request', 'scope must be "archived" or "finished"');
}

export async function createStorageRoutes(fastify: FastifyInstance, opts: StorageRoutesOptions) {
  fastify.get('/storage', async (request, reply): Promise<StorageOverview | StorageProblem> => {
    requireOwner(request);
    const db = getDb();
    const folders: StorageFolderView[] = [];
    const backupInCache = !!opts.cacheDir && isInside(opts.cacheDir, opts.backupDir);
    const cacheDir = opts.cacheDir;
    // free space per filesystem (statfs, the doctor's disk check); a failure
    // here leaves it out instead of failing the page
    const disk = diskSpace({
      ...(process.env.DATABASE_URL ? { databaseUrl: process.env.DATABASE_URL } : {}),
      ...(cacheDir ? { cacheDir } : {}),
      backupDir: opts.backupDir,
      fresh: true,
    }).catch((err: unknown) => {
      request.log.warn({ err }, 'disk space measurement failed');
      return null;
    });
    let database, cache, backups;
    try {
      [database, cache, backups] = await Promise.all([
        measure('database', 'the database', () => databaseUsage(db)),
        cacheDir ? measure('cache', `the cache folder (${cacheDir})`, () => folderUsage(cacheDir, backupInCache ? { skip: opts.backupDir } : {})) : null,
        measure('backups', `the backups folder (${opts.backupDir})`, () => folderUsage(opts.backupDir)),
      ]);
    } catch (err) {
      const problem = storageProblem(err);
      if (!problem) throw err;
      request.log.error({ err, step: problem.step }, 'storage measurement failed');
      return reply.code(problem.status).send(problem);
    }
    if (opts.cacheDir && cache) {
      folders.push({ key: 'cache', label: 'Cache folder', path: opts.cacheDir, ...cache });
    }
    folders.push({ key: 'backups', label: 'Backups folder', path: opts.backupDir, ...backups });
    return { checkedAt: new Date().toISOString(), database, folders, disk: await disk };
  });

  fastify.get('/storage/tag-changes', async (request) => {
    requireOwner(request);
    return previewTagChangeCleanup(getDb(), scopeOf((request.query as { scope?: string }).scope));
  });

  fastify.post('/storage/tag-changes/cleanup', async (request) => {
    requireOwner(request);
    const parsed = tagChangeCleanupRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new ApiError(400, 'Bad Request', 'Send { "scope": "archived" | "finished", "includeRevertible": boolean }');
    }
    const result = await runTagChangeCleanup(getDb(), parsed.data.scope, parsed.data.includeRevertible);
    request.log.info({ ...parsed.data, ...result }, 'tag-change cleanup');
    return result;
  });
}
