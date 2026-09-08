/**
 * Scheduled scanning (spec LIB-4): every ten minutes, look at each enabled
 * root and enqueue a scan when its poll interval has elapsed since the last
 * completed one — a quick scan (directory mtimes) normally, a full scan when
 * the last full one is older than a week or there has never been one. A root
 * with a scan still running is left alone.
 */
import { and, desc, eq } from 'drizzle-orm';
import { scanRoots, scans } from '@liner/db';
import type { WorkerContext } from '../lib/context.js';

export interface ScanSweepJobData {
  /** default 7 days */
  fullEveryDays?: number;
}

export function scanDecision(input: {
  now: Date;
  pollIntervalS: number;
  lastCompletedAt: Date | null;
  lastFullCompletedAt: Date | null;
  running: boolean;
  fullEveryDays: number;
}): 'full' | 'quick' | null {
  if (input.running) return null;
  const due = input.lastCompletedAt === null
    || input.now.getTime() - input.lastCompletedAt.getTime() >= input.pollIntervalS * 1000;
  if (!due) return null;
  const fullDue = input.lastFullCompletedAt === null
    || input.now.getTime() - input.lastFullCompletedAt.getTime() >= input.fullEveryDays * 86_400_000;
  return fullDue ? 'full' : 'quick';
}

/** A 'running' scan older than this never finished (worker died mid-walk); it must not block the schedule. */
export const STALE_RUNNING_MS = 12 * 3600_000;

export async function scanSweepJob(ctx: WorkerContext, data: ScanSweepJobData): Promise<void> {
  const fullEveryDays = data.fullEveryDays ?? 7;
  const roots = await ctx.db.select().from(scanRoots).where(eq(scanRoots.enabled, true));
  const now = new Date();
  let enqueued = 0;

  for (const root of roots) {
    const recent = await ctx.db
      .select({ id: scans.id, status: scans.status, startedAt: scans.startedAt, finishedAt: scans.finishedAt, stats: scans.stats })
      .from(scans)
      .where(eq(scans.scanRootId, root.id))
      .orderBy(desc(scans.startedAt))
      .limit(30);
    const stale = recent.filter((s) => s.status === 'running' && now.getTime() - s.startedAt.getTime() > STALE_RUNNING_MS);
    for (const s of stale) {
      await ctx.db.update(scans)
        .set({ status: 'aborted', finishedAt: now, stats: { ...((s.stats as Record<string, unknown> | null) ?? {}), error: 'never finished; marked stale by scan.sweep' } })
        .where(eq(scans.id, s.id));
      ctx.logger.warn({ scanRootId: root.id, scanId: s.id, startedAt: s.startedAt }, 'scan sweep: stale running scan marked aborted');
    }
    const running = recent.some((s) => s.status === 'running' && !stale.includes(s));
    const completed = recent.filter((s) => s.status === 'completed' && s.finishedAt);
    const lastCompletedAt = completed[0]?.finishedAt ?? null;
    // Scans before 0019 recorded no mode; they were all full walks.
    const lastFull = completed.find((s) => ((s.stats as { mode?: string } | null)?.mode ?? 'full') === 'full');
    const lastFullCompletedAt = lastFull?.finishedAt ?? null;

    const mode = scanDecision({
      now, pollIntervalS: root.pollIntervalS, lastCompletedAt, lastFullCompletedAt, running, fullEveryDays,
    });
    if (!mode) continue;
    const jobId = await ctx.boss.send('scan.root', { scanRootId: root.id, mode }, { singletonKey: `scan:${root.id}` });
    if (jobId) {
      enqueued++;
      ctx.logger.info({ scanRootId: root.id, mode, lastCompletedAt, lastFullCompletedAt }, 'scan sweep: enqueued');
    }
  }
  ctx.logger.info({ roots: roots.length, enqueued }, 'scan sweep');
}

// keep `and` referenced for future filters without an unused-import error
void and;
