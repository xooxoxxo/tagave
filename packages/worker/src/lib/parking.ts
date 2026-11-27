/**
 * The park rule (vault "tagave - Offline Library Spec", section 4 "Job queue
 * behaviour: wait, never fail"): a handler that throws FolderOfflineError
 * parks its job in parked_jobs and completes the pg-boss job with
 * `{ parked: true }`, so it is neither failed nor retried. The folder watch
 * sends it again when the folder is back (folderWatch/watch.ts onlineAgain).
 *
 * Maintenance tasks park inside runMaintenance (lib/maintenance.ts), as the
 * task row; their jobs never reach the park here with the error.
 */
import { parkJob, rootReach } from '@tagave/db';
import type { WorkerContext } from './context.js';
import { folderWatch } from './folderWatch/watch.js';
import { FolderOfflineError } from './folderOffline.js';

export const PARKED_OUTPUT = { parked: true } as const;
export const WAITING_STAGE = 'Waiting for the music folder';

export type RootOf<T> = (data: T) => Promise<string | null> | string | null;

/** A sweep over every root has no root of its own: an offline error rethrows (the sweep skips the root itself). */
export const NO_ROOT = (): null => null;

/**
 * Wraps a pg-boss handler: a FolderOfflineError parks the job and completes it with { parked: true }.
 *
 * The row is the offline folder's (the error's root) with the error's reason.
 * `rootOf` is asked only then: a job it finds no root for (a sweep over every
 * root) rethrows, as today. Any other error rethrows untouched.
 */
export function parkable<T extends object>(
  ctx: WorkerContext,
  queue: string,
  rootOf: RootOf<T>,
  singletonOf: (data: T) => string | null,
  handler: (job: { id: string; data: T }) => Promise<unknown>,
): (job: { id: string; data: T }) => Promise<unknown> {
  return async (job) => {
    try {
      return await handler(job);
    } catch (err) {
      if (!(err instanceof FolderOfflineError)) throw err;
      let root: string | null;
      try {
        root = await rootOf(job.data);
      } catch {
        root = null;
      }
      if (root === null) throw err;
      await parkJob(ctx.sql, { scanRootId: err.scanRootId, queue, data: job.data, singletonKey: singletonOf(job.data), reason: err.reason });
      folderWatch()?.suspect(err.scanRootId);
      ctx.logger.warn({ jobId: job.id, queue, scanRootId: err.scanRootId, reason: err.reason }, `${queue} parked: music folder offline`);
      return PARKED_OUTPUT;
    }
  };
}

/**
 * Before file work: parks at once when the root is not online (offline or not
 * connected), without waiting for a gate deadline. A root with no reading yet
 * (unknown: a fresh start, before the watch's first tick) runs: the gate
 * still guards each call.
 */
export async function requireOnline(ctx: WorkerContext, rootId: string): Promise<void> {
  const { reach, reason } = await rootReach(ctx.sql, rootId);
  if (reach === 'offline') throw new FolderOfflineError(rootId, reason ?? 'timeout');
  if (reach === 'unmounted') throw new FolderOfflineError(rootId, reason ?? 'not_mounted');
}

/** The root of a Tag Plan's files (its items; a split-first plan's file before it has items). */
export async function rootOfPlan(ctx: WorkerContext, planId: string): Promise<string | null> {
  const [row] = await ctx.sql<{ root: string | null }[]>`
    select coalesce(
      (select f.scan_root_id from tag_plan_items i join files f on f.id = i.audio_file_id where i.tag_plan_id = ${planId} limit 1),
      (select f.scan_root_id from album_splits s join files f on f.id = s.file_id where s.tag_plan_id = ${planId} limit 1)
    )::text as root`;
  return row?.root ?? null;
}

/** The root of an album's files. */
export async function rootOfAlbum(ctx: WorkerContext, albumId: string): Promise<string | null> {
  const [row] = await ctx.sql<{ root: string }[]>`
    select f.scan_root_id::text as root from local_tracks t join files f on f.id = t.audio_file_id
    where t.local_album_id = ${albumId} limit 1`;
  return row?.root ?? null;
}

/** The root of a file. */
export async function rootOfFile(ctx: WorkerContext, fileId: string): Promise<string | null> {
  const [row] = await ctx.sql<{ root: string }[]>`select scan_root_id::text as root from files where id = ${fileId}`;
  return row?.root ?? null;
}

/** The root of a track's file. */
export async function rootOfTrack(ctx: WorkerContext, trackId: string): Promise<string | null> {
  const [row] = await ctx.sql<{ root: string }[]>`
    select f.scan_root_id::text as root from local_tracks t join files f on f.id = t.audio_file_id where t.id = ${trackId}`;
  return row?.root ?? null;
}
