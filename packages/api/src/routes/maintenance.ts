import type { FastifyInstance, FastifyRequest } from 'fastify';
import { cancelMaintenanceTask, getMaintenanceTask, listMaintenanceTasks, restartMaintenanceTask, type MaintenanceRow } from '@tagave/db';
import { can } from '@tagave/shared';
import { getSql } from '../db.js';
import { ApiError } from '../middleware/errorHandler.js';
import { dispatchMaintenance, foldersAway, liveMaintenanceQueues, liveMaintenanceView, maintenanceView } from '../lib/maintenance.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const base = '/libraries/:libraryId/maintenance-tasks';
const permitted = (request: FastifyRequest, task: MaintenanceRow) => task.kind === 'cover' || can(request.user?.role, 'system.manage');

async function taskOf(request: FastifyRequest): Promise<MaintenanceRow> {
  const { libraryId, taskId } = request.params as { libraryId: string; taskId: string };
  const task = UUID.test(libraryId) && UUID.test(taskId) ? await getMaintenanceTask(getSql(), libraryId, taskId) : null;
  if (!task || !permitted(request, task)) throw new ApiError(404, 'Not Found', 'Maintenance task not found');
  return task;
}

export async function createMaintenanceRoutes(app: FastifyInstance) {
  app.get(base, async (request) => {
    const { libraryId } = request.params as { libraryId: string };
    if (!UUID.test(libraryId)) throw new ApiError(404, 'Not Found', 'Library not found');
    const rows = (await listMaintenanceTasks(getSql(), libraryId)).filter((row) => permitted(request, row));
    const [queues, away] = rows.length ? await Promise.all([liveMaintenanceQueues(), foldersAway(rows)]) : [[], new Set<string>()];
    return { tasks: rows.map((row) => maintenanceView(row, queues, away)) };
  });
  app.get(`${base}/:taskId`, async (request) => liveMaintenanceView(await taskOf(request)));
  app.post(`${base}/:taskId/:action`, async (request) => {
    const { action } = request.params as { action: string };
    if (action !== 'retry' && action !== 'continue' && action !== 'cancel' && action !== 'restore-original') throw new ApiError(404, 'Not Found', 'Task action not found');
    const row = await taskOf(request);
    const [queues, away] = await Promise.all([liveMaintenanceQueues(), foldersAway([row])]);
    const view = maintenanceView(row, queues, away);
    if (!view.actions.includes(action)) throw new ApiError(409, 'Conflict', 'That action is no longer available');
    // paused for a music folder that is still offline: Continue waits for the owner to bring it back
    if (action === 'continue' && view.waitsForFolder) throw new ApiError(409, 'Conflict', 'The music folder is still offline. Press Continue when it is back.');
    const sql = getSql();
    const next = action === 'cancel'
      ? await cancelMaintenanceTask(sql, row.library_id, row.id)
      : await restartMaintenanceTask(sql, row.library_id, row.id, row.attempt, action === 'restore-original');
    if (!next) throw new ApiError(409, 'Conflict', 'The task changed. Reload and try again.');
    if (next.state === 'waiting') await dispatchMaintenance(row.id, request.log);
    return maintenanceView(next, queues, away);
  });
}
