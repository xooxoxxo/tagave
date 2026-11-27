import {
  PARKED_MAINTENANCE_QUEUE, currentMaintenanceClaim, parkJob, parkMaintenanceTask, updateMaintenanceTask, withMaintenanceClaim,
  type MaintenanceRow, type MaintenanceUpdate, type MaintenanceWork,
} from '@tagave/db';
import { JOB_EVENTS_CHANNEL } from '@tagave/shared/job';
import type { WorkerContext } from './context.js';
import { FolderOfflineError } from './folderOffline.js';
import { folderWatch } from './folderWatch/watch.js';
import { WAITING_STAGE } from './parking.js';

/**
 * Task queues whose work resumes on its own when the music folder is back:
 * the task parks (state 'waiting', held until the return). Every other
 * queue's task (files.split, files.move, files.upgrade, files.trash) writes
 * files the owner chose to move or cut, and waits for the owner's Continue
 * instead (Decision 2): interrupted, with the folder in its checkpoint.
 */
export const RESUMES_ON_ITS_OWN: readonly string[] = ['tags.apply', 'files.embedCover', 'art.fetch'];
export const PAUSED_OFFLINE_STAGE = 'Paused while the music folder is offline';

export interface MaintenanceRun {
  row: MaintenanceRow;
  /** Throws if the attempt no longer owns the task. Call before file changes. */
  current(): Promise<MaintenanceRow>;
  update(patch: MaintenanceUpdate): Promise<void>;
}

export async function runMaintenance(
  ctx: WorkerContext,
  work: MaintenanceWork,
  run: (task: MaintenanceRun) => Promise<MaintenanceUpdate>,
): Promise<void> {
  await withMaintenanceClaim(ctx.sql, work, async (row) => {
    const current = async () => {
      const current = await currentMaintenanceClaim(ctx.sql, work);
      if (!current) throw new Error('Maintenance attempt no longer owns the task');
      return current;
    };
    const update = async (patch: MaintenanceUpdate) => {
      if (!await updateMaintenanceTask(ctx.sql, work, patch)) throw new Error('Maintenance attempt no longer owns the task');
      try {
        await ctx.sql`select pg_notify(${JOB_EVENTS_CHANNEL}, ${JSON.stringify({
          type: 'maintenance.changed', libraryId: row.library_id, kind: row.kind, subjectId: row.subject_id,
        })})`;
      } catch (err) {
        ctx.logger.warn({ err, taskId: row.id }, 'maintenance notification failed');
      }
    };
    try {
      await update(await run({ row, current, update }));
    } catch (err) {
      if (err instanceof FolderOfflineError) {
        await offline(ctx, work, row, err, update);
        return;
      }
      ctx.logger.warn({ err, taskId: row.id }, 'maintenance task stopped');
      if (await currentMaintenanceClaim(ctx.sql, work)) {
        await update({ state: 'failed', stage: 'Task failed', error: err instanceof Error ? err.message : 'The task could not finish.' });
      }
    }
  });
}

/** The task's folder went offline: park it, or pause it for the owner (RESUMES_ON_ITS_OWN). */
async function offline(
  ctx: WorkerContext,
  work: MaintenanceWork,
  row: MaintenanceRow,
  err: FolderOfflineError,
  update: (patch: MaintenanceUpdate) => Promise<void>,
): Promise<void> {
  const fields = { taskId: row.id, queue: row.queue, scanRootId: err.scanRootId, reason: err.reason };
  folderWatch()?.suspect(err.scanRootId);
  if (!RESUMES_ON_ITS_OWN.includes(row.queue)) {
    const claim = await currentMaintenanceClaim(ctx.sql, work);
    if (!claim) return;
    // the run's own checkpoint (its put-back) is kept: the owner's Continue reads it
    await update({ state: 'interrupted', stage: PAUSED_OFFLINE_STAGE, checkpoint: { ...(claim.checkpoint ?? {}), offlineRootId: err.scanRootId } });
    ctx.logger.warn(fields, 'maintenance task paused: music folder offline');
    return;
  }
  const parked = await ctx.sql.begin(async (tx) => {
    if (!(await parkMaintenanceTask(tx, work, WAITING_STAGE))) return false;
    await parkJob(tx, { scanRootId: err.scanRootId, queue: PARKED_MAINTENANCE_QUEUE, data: { taskId: row.id }, singletonKey: `maintenance:${row.id}`, reason: err.reason });
    return true;
  });
  if (!parked) return;
  ctx.logger.warn(fields, 'maintenance parked: music folder offline');
  try {
    await ctx.sql`select pg_notify(${JOB_EVENTS_CHANNEL}, ${JSON.stringify({
      type: 'maintenance.changed', libraryId: row.library_id, kind: row.kind, subjectId: row.subject_id,
    })})`;
  } catch (notifyErr) {
    ctx.logger.warn({ err: notifyErr, taskId: row.id }, 'maintenance notification failed');
  }
}
