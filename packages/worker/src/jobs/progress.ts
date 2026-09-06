import { eq } from 'drizzle-orm';
import { jobRuns } from '@liner/db';
import type { WorkerContext } from '../lib/context.js';

export interface ProgressUpdate {
  libraryId: string;
  type: string;
  subjectType?: string;
  subjectId?: string;
  state: 'running' | 'completed' | 'failed' | 'cancelled';
  done?: number;
  total?: number;
  etaS?: number;
  message?: string;
  error?: string;
  pgbossId?: string;
}

/**
 * Upsert the app-owned job mirror (spec §11.4 job_runs) and NOTIFY the API,
 * which fans the event out over SSE. Returns the job_runs row id so callers
 * can keep updating the same row.
 */
export async function reportProgress(
  ctx: WorkerContext,
  jobRunId: string | null,
  u: ProgressUpdate,
): Promise<string> {
  const progress = {
    done: u.done ?? 0,
    total: u.total ?? 0,
    ...(u.etaS !== undefined ? { etaS: u.etaS } : {}),
    ...(u.message !== undefined ? { message: u.message } : {}),
  };
  const now = new Date();

  let id = jobRunId;
  if (id) {
    await ctx.db
      .update(jobRuns)
      .set({
        state: u.state,
        progress,
        ...(u.error !== undefined ? { error: u.error } : {}),
        ...(u.state === 'completed' || u.state === 'failed' || u.state === 'cancelled'
          ? { finishedAt: now }
          : {}),
      })
      .where(eq(jobRuns.id, id));
  } else {
    const inserted = await ctx.db
      .insert(jobRuns)
      .values({
        libraryId: u.libraryId,
        type: u.type,
        subjectType: u.subjectType ?? null,
        subjectId: u.subjectId ?? null,
        state: u.state,
        progress,
        startedAt: now,
        pgbossId: u.pgbossId ?? null,
        ...(u.error !== undefined ? { error: u.error } : {}),
      })
      .returning({ id: jobRuns.id });
    const row = inserted[0];
    if (!row) throw new Error('job_runs insert returned no row');
    id = row.id;
  }

  const event = {
    type:
      u.state === 'completed' ? 'job.completed'
      : u.state === 'failed' ? 'job.failed'
      : 'job.progress',
    jobRunId: id,
    libraryId: u.libraryId,
    jobType: u.type,
    state: u.state,
    progress,
    ...(u.error !== undefined ? { error: u.error } : {}),
  };
  // NOTIFY payload cap is 8000 bytes; our events are small, but guard anyway.
  const payload = JSON.stringify(event).slice(0, 7900);
  await ctx.sql`select pg_notify('liner_jobs', ${payload})`;
  return id;
}

/**
 * Fan-out hook for the API's SSE stream (spec §11.4 `queue.changed`): an
 * identification decision changed the review queue / coverage counters.
 * Payload stays tiny; clients refetch the counts they show.
 */
export async function notifyQueueChanged(
  ctx: WorkerContext,
  libraryId: string,
  localAlbumId: string,
  state: string,
): Promise<void> {
  const payload = JSON.stringify({ type: 'queue.changed', libraryId, localAlbumId, state });
  try {
    await ctx.sql`select pg_notify('liner_jobs', ${payload})`;
  } catch (err) {
    ctx.logger.warn({ err: (err as Error).message }, 'queue.changed notify failed');
  }
}
