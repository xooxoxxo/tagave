/**
 * Settings › Backups: list the dumps in the backups folder, take one now,
 * download or delete one, and change the nightly schedule and retention.
 * Owner only: a dump holds the whole catalog.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  deleteBackup,
  isSafeBackupName,
  listBackups,
  readBackupStatus,
  writeBackupSettings,
  type BackupEntry,
} from '@liner/doctor';
import { backupSettingsSchema, type BackupsStatus } from '@liner/shared';
import { ApiError } from '../middleware/errorHandler.js';
import type { BackupService } from '../lib/backupService.js';

export interface BackupRoutesOptions {
  service: BackupService;
  /** Called after the settings change so the nightly schedule follows. */
  onSettingsChanged?: () => Promise<void>;
}

function requireOwner(request: FastifyRequest): void {
  if (!request.user) throw new ApiError(401, 'Unauthorized', 'Authentication required');
  if (request.user.role !== 'owner') throw new ApiError(403, 'Forbidden', 'Only the owner can manage backups');
}

async function findBackup(service: BackupService, name: string): Promise<BackupEntry> {
  if (!isSafeBackupName(name)) throw new ApiError(400, 'Bad Request', 'Not a backup file name');
  const entry = (await listBackups(service.dir)).find((e) => e.name === name);
  if (!entry) throw new ApiError(404, 'Not Found', 'No backup with that name');
  return entry;
}

export async function buildBackupsStatus(service: BackupService): Promise<BackupsStatus> {
  let backups: BackupEntry[] = [];
  let error: string | null = null;
  try {
    backups = await listBackups(service.dir);
  } catch (err) {
    error = `Could not read the backups folder: ${(err as Error).message}`;
  }
  const status = await readBackupStatus(service.dir);
  return {
    dir: service.dir,
    dedicated: service.dedicated,
    timeZone: service.timeZone,
    settings: await service.settings(),
    running: service.running,
    lastRun: status.lastRun,
    lastNightly: status.lastNightly,
    backups,
    totalBytes: backups.reduce((sum, b) => sum + b.bytes, 0),
    error,
  };
}

export async function createBackupRoutes(fastify: FastifyInstance, opts: BackupRoutesOptions) {
  const { service } = opts;

  fastify.get('/backups', async (request) => {
    requireOwner(request);
    return buildBackupsStatus(service);
  });

  // Starts a backup and answers at once; the page polls GET /backups while
  // `running` is true. A dump of a large catalog can outlast a proxy timeout.
  fastify.post('/backups', async (request, reply) => {
    requireOwner(request);
    const done = service.run('manual');
    done.then(
      (record) => { if (!record.ok) request.log.error({ error: record.error }, 'manual backup failed'); },
      (err: unknown) => request.log.error({ err }, 'manual backup failed'),
    );
    return reply.status(202).send(await buildBackupsStatus(service));
  });

  fastify.get('/backups/:name/download', async (request, reply) => {
    requireOwner(request);
    const { name } = request.params as { name: string };
    await findBackup(service, name);
    const path = join(service.dir, name);
    const { size } = await stat(path);
    return reply
      .header('Content-Type', 'application/octet-stream')
      .header('Content-Disposition', `attachment; filename="${name}"`)
      .header('Content-Length', String(size))
      .header('Cache-Control', 'no-store')
      .send(createReadStream(path));
  });

  fastify.delete('/backups/:name', async (request, reply) => {
    requireOwner(request);
    const { name } = request.params as { name: string };
    await findBackup(service, name);
    await deleteBackup(service.dir, name);
    return reply.status(204).send();
  });

  fastify.put('/backups/settings', async (request) => {
    requireOwner(request);
    const parsed = backupSettingsSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError(400, 'Bad Request', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    }
    await writeBackupSettings(service.dir, parsed.data);
    if (opts.onSettingsChanged) {
      try {
        await opts.onSettingsChanged();
      } catch (err) {
        request.log.error({ err }, 'could not apply the backup schedule');
        throw new ApiError(500, 'Schedule not applied', 'The settings were saved, but the nightly schedule could not be updated. Restart the app to apply them.');
      }
    }
    return buildBackupsStatus(service);
  });
}
