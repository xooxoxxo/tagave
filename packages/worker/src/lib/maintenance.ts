import {
  currentMaintenanceClaim, updateMaintenanceTask, withMaintenanceClaim,
  type MaintenanceRow, type MaintenanceUpdate, type MaintenanceWork,
} from '@tagave/db';
import { JOB_EVENTS_CHANNEL } from '@tagave/shared/job';
import type { WorkerContext } from './context.js';

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
      ctx.logger.warn({ err, taskId: row.id }, 'maintenance task stopped');
      if (await currentMaintenanceClaim(ctx.sql, work)) {
        await update({ state: 'failed', stage: 'Task failed', error: err instanceof Error ? err.message : 'The task could not finish.' });
      }
    }
  });
}
