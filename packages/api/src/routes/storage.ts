/**
 * Settings › Storage: disk use of everything tagave keeps (database groups,
 * the cache and backups folders) and the cleanup of finished tag changes.
 * Owner only: it names paths and covers every library.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  tagChangeCleanupRequestSchema,
  type StorageFolderView,
  type StorageOverview,
  type TagChangeCleanupScope,
} from '@liner/shared';
import { getDb } from '../db.js';
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

function scopeOf(raw: unknown): TagChangeCleanupScope {
  if (raw === undefined || raw === 'archived') return 'archived';
  if (raw === 'finished') return 'finished';
  throw new ApiError(400, 'Bad Request', 'scope must be "archived" or "finished"');
}

export async function createStorageRoutes(fastify: FastifyInstance, opts: StorageRoutesOptions) {
  fastify.get('/storage', async (request): Promise<StorageOverview> => {
    requireOwner(request);
    const db = getDb();
    const folders: StorageFolderView[] = [];
    const backupInCache = !!opts.cacheDir && isInside(opts.cacheDir, opts.backupDir);
    const [database, cache, backups] = await Promise.all([
      databaseUsage(db),
      opts.cacheDir ? folderUsage(opts.cacheDir, backupInCache ? { skip: opts.backupDir } : {}) : null,
      folderUsage(opts.backupDir),
    ]);
    if (opts.cacheDir && cache) {
      folders.push({ key: 'cache', label: 'Cache folder', path: opts.cacheDir, ...cache });
    }
    folders.push({ key: 'backups', label: 'Backups folder', path: opts.backupDir, ...backups });
    return { checkedAt: new Date().toISOString(), database, folders };
  });

  fastify.get('/storage/tag-changes', async (request) => {
    const userId = requireOwner(request);
    return previewTagChangeCleanup(getDb(), userId, scopeOf((request.query as { scope?: string }).scope));
  });

  fastify.post('/storage/tag-changes/cleanup', async (request) => {
    const userId = requireOwner(request);
    const parsed = tagChangeCleanupRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new ApiError(400, 'Bad Request', 'Send { "scope": "archived" | "finished", "includeRevertible": boolean }');
    }
    const result = await runTagChangeCleanup(getDb(), userId, parsed.data.scope, parsed.data.includeRevertible);
    request.log.info({ ...parsed.data, ...result }, 'tag-change cleanup');
    return result;
  });
}
