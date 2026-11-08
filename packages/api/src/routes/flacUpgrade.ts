import type { FastifyInstance } from 'fastify';
import { flacUpgradeSource, latestMaintenanceTask, lidarrEnabled, lidarrStoredSettings, saveMaintenanceTask, type MaintenanceRow } from '@tagave/db';
import type { FlacUpgradeView } from '@tagave/shared';
import { getSql } from '../db.js';
import { dispatchMaintenance, liveMaintenanceQueues, maintenanceView } from '../lib/maintenance.js';
import { ApiError } from '../middleware/errorHandler.js';

const base = '/libraries/:libraryId/albums/:albumId/flac-upgrade';
const owner = { config: { permission: 'system.manage' as const } };
type Params = { libraryId: string; albumId: string };

async function available(libraryId: string): Promise<boolean> {
  const sql = getSql();
  if (!await lidarrEnabled(sql)) return false;
  const settings = await lidarrStoredSettings(sql);
  if (!settings.url || !settings.apiKey || settings.useDropPool === false) return false;
  const [pool] = await sql<{ available: boolean }[]>`
    select exists (
      select 1 from libraries l join scan_roots sr on sr.id::text = l.settings->'dropPool'->>'scanRootId'
      where l.id = ${libraryId} and sr.library_id = l.id and sr.enabled and sr.writable
        and l.settings->'dropPool'->>'enabled' = 'true' and coalesce(l.settings->'dropPool'->>'dirPath', '') <> ''
    ) as available
  `;
  return pool?.available === true;
}

export async function createFlacUpgradeRoutes(app: FastifyInstance) {
  app.get<{ Params: Params }>(base, owner, async (request): Promise<FlacUpgradeView> => {
    const { libraryId, albumId } = request.params;
    const sql = getSql();
    const [task] = await sql<MaintenanceRow[]>`
      select * from maintenance_tasks where library_id = ${libraryId} and kind = 'flac-upgrade'
        and (scope_key = ${albumId} or subject_id = ${albumId}::uuid) order by created_at desc limit 1`;
    const active = task && !['done', 'cancelled'].includes(task.state);
    return {
      eligible: !active && await available(libraryId) && !!await flacUpgradeSource(sql, libraryId, albumId),
      task: task ? maintenanceView(task, await liveMaintenanceQueues()) : null,
    };
  });

  app.post<{ Params: Params }>(base, owner, async (request, reply) => {
    const { libraryId, albumId } = request.params;
    const sql = getSql();
    const existing = await latestMaintenanceTask(sql, libraryId, 'flac-upgrade', albumId);
    if (existing && !['done', 'cancelled'].includes(existing.state)) {
      return reply.status(202).send(maintenanceView(existing, await liveMaintenanceQueues()));
    }
    if (!await available(libraryId)) throw new ApiError(409, 'Conflict', 'Connect Lidarr to the drop pool first.');
    const source = await flacUpgradeSource(sql, libraryId, albumId);
    if (!source) throw new ApiError(409, 'Conflict', 'This album needs a complete matched edition and writable files to upgrade.');
    const task = await saveMaintenanceTask(sql, {
      libraryId, kind: 'flac-upgrade', scope: albumId, subjectId: albumId, queue: 'files.upgrade',
      input: { albumId, releaseId: source.releaseId, fileIds: source.files.map((f) => f.id), userId: request.user!.id },
      stage: 'FLAC upgrade queued',
    });
    await dispatchMaintenance(task.id, request.log);
    return reply.status(202).send(maintenanceView(task, await liveMaintenanceQueues()));
  });
}
