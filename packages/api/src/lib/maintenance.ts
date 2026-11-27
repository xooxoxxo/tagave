import { dispatchMaintenanceTask, maintenanceSender, notOnlineRoots, reconcileMaintenanceTasks, undispatchedMaintenanceTasks, type MaintenanceRow } from '@tagave/db';
import { workerServesQueue } from '@tagave/core';
import type { MaintenanceTaskView } from '@tagave/shared';
import type { FastifyBaseLogger } from 'fastify';
import { getBoss } from '../boss.js';
import { getSql } from '../db.js';

export { maintenanceSender };

export async function dispatchMaintenance(id: string, logger: FastifyBaseLogger): Promise<void> {
  try {
    await dispatchMaintenanceTask(getSql(), maintenanceSender(await getBoss()), id);
  } catch (err) {
    // Intent is already committed. The outbox will try again without a second task.
    logger.warn({ err, taskId: id }, 'maintenance dispatch delayed');
  }
}

export async function maintainTaskQueue(logger: FastifyBaseLogger): Promise<void> {
  const sql = getSql();
  await reconcileMaintenanceTasks(sql);
  for (const id of await undispatchedMaintenanceTasks(sql)) await dispatchMaintenance(id, logger);
}

export function startMaintenanceQueue(logger: FastifyBaseLogger): () => void {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try { await maintainTaskQueue(logger); }
    catch (err) { logger.warn({ err }, 'maintenance queue check failed'); }
    finally { busy = false; }
  };
  const timer = setInterval(() => void tick(), 5_000).unref();
  return () => clearInterval(timer);
}

export async function liveMaintenanceQueues(): Promise<string[]> {
  const rows = await getSql()<{ queues: unknown }[]>`
    select info->'queues' as queues from worker_heartbeats where seen_at > now() - interval '120 seconds'
  `;
  return rows.flatMap(({ queues }) => Array.isArray(queues) ? queues.map(String) : ['*']);
}

/** The music folder a task paused for (the worker's checkpoint.offlineRootId), or null. */
function pausedFor(row: MaintenanceRow): string | null {
  const id = row.checkpoint?.offlineRootId;
  return typeof id === 'string' ? id : null;
}

/**
 * The music folders some of these tasks paused for that are still offline or
 * not connected, among enabled roots only. A folder removed since is not
 * waited for. Nor is a folder turned off since: the folder watch reads only
 * enabled roots, so a turned-off root's reach stays frozen at what it last
 * read (offline, say), and waiting on it would refuse Continue for good.
 * No query when no task paused for a folder.
 */
export async function foldersAway(rows: readonly MaintenanceRow[]): Promise<ReadonlySet<string>> {
  if (!rows.some((row) => pausedFor(row) !== null)) return new Set();
  return new Set((await notOnlineRoots(getSql())).keys());
}

/** One task's view with the live worker queues and its music folder. */
export async function liveMaintenanceView(row: MaintenanceRow): Promise<MaintenanceTaskView> {
  const [queues, away] = await Promise.all([liveMaintenanceQueues(), foldersAway([row])]);
  return maintenanceView(row, queues, away);
}

/**
 * `away` (foldersAway): with it, a task that paused for a music folder says
 * whether it still waits for it (`waitsForFolder`); without it the field is left out.
 */
export function maintenanceView(row: MaintenanceRow, queues: readonly string[], away?: ReadonlySet<string>): MaintenanceTaskView {
  const workerAvailable = workerServesQueue(queues, row.queue);
  const folder = pausedFor(row);
  const actions: MaintenanceTaskView['actions'] = [];
  if (workerAvailable && ['interrupted', 'failed', 'review'].includes(row.state)) {
    actions.push(row.checkpoint ? 'continue' : 'retry');
  }
  const swap = row.checkpoint?.swap as { phase?: string } | undefined;
  if (workerAvailable && row.kind === 'flac-upgrade' && !row.checkpoint?.restoreOriginal &&
      ['review', 'failed', 'interrupted'].includes(row.state) && swap?.phase && ['publish', 'catalog'].includes(swap.phase)) {
    actions.push('restore-original');
  }
  if (row.kind === 'empty-trash' && !row.cancel_requested && row.state !== 'done' && row.state !== 'cancelled') {
    actions.push('cancel');
  }
  return {
    id: row.id, kind: row.kind, subjectId: row.subject_id, state: row.state,
    stage: row.state === 'waiting' && !workerAvailable ? 'Waiting for the file worker'
      : row.state === 'running' && !workerAvailable ? 'The file worker is not responding'
      : row.stage,
    progress: row.progress, error: row.error, attempt: row.attempt, updatedAt: new Date(row.updated_at).toISOString(),
    cancelRequested: row.cancel_requested, workerAvailable, actions,
    ...(folder !== null && away ? { waitsForFolder: away.has(folder) && ['interrupted', 'failed', 'review'].includes(row.state) } : {}),
  };
}
