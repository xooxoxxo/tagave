import { and, eq } from 'drizzle-orm';
import { localAlbums } from '@liner/db';
import type { WorkerContext } from '../lib/context.js';
import { reportProgress } from './progress.js';

export interface IdentifySweepJobData {
  libraryId: string;
  /** cap on albums to enqueue this sweep (default 500) */
  limit?: number;
}

/** Enqueues identify.album for every pending cluster, oldest first. MB's
 * 1 req/s budget means ~2-4 albums/minute; the sweep is restartable and
 * idempotent (singleton per album). */
export async function identifySweepJob(ctx: WorkerContext, data: IdentifySweepJobData): Promise<void> {
  const limit = data.limit ?? 500;
  const pending = await ctx.db
    .select({ id: localAlbums.id })
    .from(localAlbums)
    .where(and(eq(localAlbums.libraryId, data.libraryId), eq(localAlbums.state, 'pending')))
    .orderBy(localAlbums.createdAt)
    .limit(limit);

  for (const row of pending) {
    await ctx.boss.send('identify.album', { localAlbumId: row.id }, {
      singletonKey: `identify:${row.id}`,
      retryLimit: 3,
      retryDelay: 60,
      retryBackoff: true,
    });
  }

  await reportProgress(ctx, null, {
    libraryId: data.libraryId,
    type: 'identify.sweep',
    state: 'completed',
    done: pending.length,
    total: pending.length,
    message: `enqueued ${pending.length} albums for identification`,
  });
  ctx.logger.info({ libraryId: data.libraryId, enqueued: pending.length }, 'identify sweep');
}
