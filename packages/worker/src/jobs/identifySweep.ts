import { and, eq, sql, desc, lt, isNull, or } from 'drizzle-orm';
import { localAlbums, libraries, jobRuns } from '@liner/db';
import type { WorkerContext } from '../lib/context.js';
import { reportProgress } from './progress.js';

export interface IdentifySweepJobData {
  /** one library, or every library when omitted (scheduled top-up) */
  libraryId?: string;
  /** cap on albums to enqueue this sweep (default 500) */
  limit?: number;
  /** enqueue only when the identify queue is running low (scheduled every 5 min) */
  topUp?: boolean;
}

/** keep at least this many identify.album jobs waiting before topping up */
const LOW_WATER = 300;
/** pending albums that failed this often without a decision stop being retried */
const MAX_ATTEMPTS = 8;
/** and are retried at most this often (provider outages come in hours) */
const RETRY_AFTER_HOURS = 6;

interface SweepCounts {
  total: number; matched: number; needs_review: number; unidentified: number; pending: number;
  decided_15m: number; queued: number;
}

/**
 * Enqueues identify.album for pending clusters (oldest first, fewest
 * attempts first) and keeps one running `identify.sweep` job_runs row per
 * library up to date with coverage, rate and ETA (spec §11.4, XO-309).
 * Scheduled every 5 minutes with `topUp`, it also re-enqueues albums whose
 * jobs failed (provider outages) once their retry window has passed, and
 * moves the hopeless ones (MAX_ATTEMPTS) into the triage view.
 */
export async function identifySweepJob(ctx: WorkerContext, data: IdentifySweepJobData): Promise<void> {
  const limit = data.limit ?? 500;
  const libs = data.libraryId
    ? [{ id: data.libraryId }]
    : await ctx.db.select({ id: libraries.id }).from(libraries);
  for (const lib of libs) await sweepLibrary(ctx, lib.id, limit, !!data.topUp);
}

async function counts(ctx: WorkerContext, libraryId: string): Promise<SweepCounts> {
  const rows = await ctx.sql`
    select count(*)::int as total,
           count(*) filter (where state = 'matched')::int as matched,
           count(*) filter (where state = 'needs_review')::int as needs_review,
           count(*) filter (where state = 'unidentified')::int as unidentified,
           count(*) filter (where state = 'pending')::int as pending,
           count(*) filter (where state <> 'pending' and last_identify_at > now() - interval '15 min')::int as decided_15m,
           (select count(*)::int from pgboss.job
             where name = 'identify.album' and state in ('created', 'retry', 'active')) as queued
      from local_albums where library_id = ${libraryId}` as unknown as SweepCounts[];
  return rows[0] as SweepCounts;
}

async function sweepLibrary(ctx: WorkerContext, libraryId: string, limit: number, topUp: boolean): Promise<void> {
  // Hopeless: attempts exhausted without a decision → triage, not the queue.
  const hopeless = await ctx.db.update(localAlbums)
    .set({ state: 'unidentified', identifyReason: 'provider_errors', updatedAt: new Date() })
    .where(and(
      eq(localAlbums.libraryId, libraryId),
      eq(localAlbums.state, 'pending'),
      sql`${localAlbums.identifyAttempts} >= ${MAX_ATTEMPTS}`,
    ))
    .returning({ id: localAlbums.id });

  const before = await counts(ctx, libraryId);
  let enqueued = 0;
  if (!topUp || before.queued < LOW_WATER) {
    const retryBefore = new Date(Date.now() - RETRY_AFTER_HOURS * 3600_000);
    const pending = await ctx.db
      .select({ id: localAlbums.id, attempts: localAlbums.identifyAttempts })
      .from(localAlbums)
      .where(and(
        eq(localAlbums.libraryId, libraryId),
        eq(localAlbums.state, 'pending'),
        or(isNull(localAlbums.lastIdentifyAt), lt(localAlbums.lastIdentifyAt, retryBefore)),
      ))
      .orderBy(localAlbums.identifyAttempts, localAlbums.createdAt)
      .limit(limit);
    for (const row of pending) {
      // XO-379: an album's first pass is Discogs-only; its later passes (after
      // RETRY_AFTER_HOURS) run MusicBrainz first. Manual/triage keep MB first.
      const id = await ctx.boss.send('identify.album', { localAlbumId: row.id, discogsFirst: (row.attempts ?? 0) === 0 }, {
        singletonKey: `identify:${row.id}`,
        retryLimit: 3,
        retryDelay: 60,
        retryBackoff: true,
      });
      if (id) enqueued++;
    }
  }

  // One running status row per library; completed once nothing is left.
  const after = enqueued || hopeless.length ? await counts(ctx, libraryId) : before;
  const decided = after.matched + after.needs_review + after.unidentified;
  const perMin = after.decided_15m / 15;
  const remaining = after.pending;
  const etaS = perMin > 0 ? Math.round(remaining / perMin * 60) : undefined;
  const done = remaining === 0 && after.queued === 0;
  const share = after.total ? Math.round((after.matched / after.total) * 1000) / 10 : 0;
  const message = done
    ? `${after.matched} of ${after.total} albums identified (${share}%)`
    : `${decided} of ${after.total} decided · ${after.matched} matched (${share}%) · ${perMin.toFixed(1)}/min · ${after.queued} queued`;

  const open = await ctx.db.select({ id: jobRuns.id }).from(jobRuns)
    .where(and(eq(jobRuns.libraryId, libraryId), eq(jobRuns.type, 'identify.sweep'), eq(jobRuns.state, 'running')))
    .orderBy(desc(jobRuns.createdAt)).limit(1);
  const rowId = open[0]?.id ?? null;
  if (!rowId && done && !enqueued) return; // nothing running, nothing to do: stay quiet
  await reportProgress(ctx, rowId, {
    libraryId,
    type: 'identify.sweep',
    state: done ? 'completed' : 'running',
    done: decided,
    total: after.total,
    ...(etaS !== undefined ? { etaS } : {}),
    message,
  });
  ctx.logger.info({ libraryId, enqueued, hopeless: hopeless.length, queued: after.queued, pending: remaining, perMin: Number(perMin.toFixed(2)) }, 'identify sweep');
}
