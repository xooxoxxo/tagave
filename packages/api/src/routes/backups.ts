/**
 * Settings › Backups: list the dumps in the backups folder (with one block
 * per kind: count, size, newest, and what its next run deletes), take one
 * now, download or delete one, and change the nightly schedule and the
 * retention of each kind.
 * Owner only: a dump holds the whole catalog.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { readBuildInfo } from '@tagave/core';
import {
  deleteBackup,
  inferBackupVersions,
  isSafeBackupName,
  listBackups,
  readBackupStatus,
  summarizeKinds,
  writeBackupSettings,
  type BackupEntry,
} from '@tagave/doctor';
import { backupSettingsSchema, type BackupsStatus } from '@tagave/shared';

/**
 * PUT /backups/settings: the per-kind numbers may be left out (a page from
 * before they existed); the saved ones are kept then.
 */
const settingsInputSchema = backupSettingsSchema.partial({ keepPreUpdate: true, keepManual: true });
import { ApiError } from '../middleware/errorHandler.js';
import type { BackupService } from '../lib/backupService.js';
import { detectInstall } from '../lib/updatesFeed.js';

const DOCTOR = 'node packages/doctor/dist/cli.js';

/**
 * The restore command for this install, with {file} for the dump's name
 * (docs/operations.md, Restore a backup). In Docker: stop the app and
 * workers, restore from a one-off container, start again, run in the
 * install folder. A source checkout runs the doctor directly.
 */
export function restoreCommand(env: NodeJS.ProcessEnv = process.env): string {
  const { method } = detectInstall(env, readBuildInfo());
  if (method === 'source') return `${DOCTOR} restore {file} --yes`;
  return [
    'docker compose stop app worker-identify worker-files',
    `docker compose run --rm --no-deps app ${DOCTOR} restore {file} --yes`,
    'docker compose up -d',
  ].join('\n');
}

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
  if (backups.some((b) => !b.version || (b.kind === 'pre-migration' && !b.toVersion))) {
    backups = inferBackupVersions(backups, await service.history());
  }
  const status = await readBackupStatus(service.dir);
  const settings = await service.settings();
  return {
    dir: service.dir,
    dedicated: service.dedicated,
    timeZone: service.timeZone,
    settings,
    running: service.running,
    lastRun: status.lastRun,
    lastNightly: status.lastNightly,
    backups,
    restoreCommand: restoreCommand(),
    kinds: summarizeKinds(backups, settings, service.timeZone),
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
    const parsed = settingsInputSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError(400, 'Bad Request', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    }
    // Saving only writes the numbers: nothing is deleted until the next run of
    // each kind, and GET /backups says what that run will delete (D5).
    const current = await service.settings();
    const { keepPreUpdate, keepManual, ...rest } = parsed.data;
    await writeBackupSettings(service.dir, {
      ...rest,
      keepPreUpdate: keepPreUpdate ?? current.keepPreUpdate,
      keepManual: keepManual === undefined ? current.keepManual : keepManual,
    });
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
