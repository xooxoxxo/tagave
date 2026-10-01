/**
 * Settings › Backups routes over a temporary backups folder. The dump itself
 * is faked (pg_dump is covered by the doctor's integration test), so this
 * runs without a database.
 */
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type PgBoss from 'pg-boss';
import type { SessionUser } from '@liner/shared/auth';
import type { BackupsStatus } from '@liner/shared';
import { errorHandler } from '../middleware/errorHandler.js';
import { BackupService, applyBackupSchedule, nightlyCron } from '../lib/backupService.js';
import { createBackupRoutes } from './backups.js';

const owner: SessionUser = { id: 'u1', email: 'o@example.com', displayName: 'Owner', role: 'owner', createdAt: new Date().toISOString() };
const viewer: SessionUser = { ...owner, id: 'u2', role: 'viewer' };

describe('backup routes', () => {
  let app: FastifyInstance;
  let dir: string;
  let as: SessionUser | undefined = owner;
  let service: BackupService;
  let release: () => void = () => undefined;
  const onSettingsChanged = vi.fn(async () => undefined);

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tagave-backup-routes-'));
    service = new BackupService({
      databaseUrl: 'postgres://unused/db',
      env: { BACKUP_DIR: dir, TZ: 'Europe/Amsterdam' },
      // A fake dump that finishes when the test says so.
      run: async ({ dir: out, kind }) => {
        await new Promise<void>((r) => { release = r; });
        const file = `liner-2026-09-29T03-00-00Z${kind === 'manual' ? '' : `-${kind}`}.pgdump`;
        await writeFile(join(out, file), 'PGDMP-fake-dump');
        await writeFile(join(out, `${file}.json`), JSON.stringify({ kind, verified: true, bytes: 15 }));
        const now = new Date().toISOString();
        return { kind, startedAt: now, finishedAt: now, ok: true, file, error: null, pruned: [] };
      },
    });
    app = Fastify();
    await errorHandler(app);
    app.addHook('preHandler', async (request) => { request.user = as; });
    await app.register(createBackupRoutes, { prefix: '/api/v1', service, onSettingsChanged });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('is owner only', async () => {
    as = viewer;
    expect((await app.inject({ method: 'GET', url: '/api/v1/backups' })).statusCode).toBe(403);
    as = undefined;
    expect((await app.inject({ method: 'GET', url: '/api/v1/backups' })).statusCode).toBe(401);
    as = owner;
  });

  it('lists an empty folder with the default settings', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/backups' });
    expect(res.statusCode).toBe(200);
    expect(res.json<BackupsStatus>()).toMatchObject({
      dir, dedicated: true, timeZone: 'Europe/Amsterdam', running: false, backups: [], totalBytes: 0,
      settings: { enabled: true, hour: 3, keepDaily: 7, keepWeekly: 4 },
    });
  });

  it('starts a backup at once and shows it running, then listed', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/backups' });
    expect(res.statusCode).toBe(202);
    expect(res.json<BackupsStatus>().running).toBe(true);
    release();
    await vi.waitFor(async () => {
      const list = (await app.inject({ method: 'GET', url: '/api/v1/backups' })).json<BackupsStatus>();
      expect(list.running).toBe(false);
      expect(list.backups).toEqual([expect.objectContaining({ name: 'liner-2026-09-29T03-00-00Z.pgdump', kind: 'manual', bytes: 15, verified: true })]);
    });
  });

  it('streams a download as an attachment', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/backups/liner-2026-09-29T03-00-00Z.pgdump/download' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toBe('attachment; filename="liner-2026-09-29T03-00-00Z.pgdump"');
    expect(res.headers['content-length']).toBe('15');
    expect(res.body).toBe('PGDMP-fake-dump');
  });

  it('refuses names that are not backups, and 404s missing ones', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/backups/..%2Fsecret.pgdump/download' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/v1/backups/backup-settings.json/download' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/v1/backups/liner-2020-01-01T00-00-00Z.pgdump/download' })).statusCode).toBe(404);
  });

  it('saves settings, validates them and re-applies the schedule', async () => {
    const bad = await app.inject({ method: 'PUT', url: '/api/v1/backups/settings', payload: { enabled: true, hour: 25, keepDaily: 0, keepWeekly: 4 } });
    expect(bad.statusCode).toBe(400);
    expect(onSettingsChanged).not.toHaveBeenCalled();
    const ok = await app.inject({ method: 'PUT', url: '/api/v1/backups/settings', payload: { enabled: false, hour: 1, keepDaily: 14, keepWeekly: 8 } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json<BackupsStatus>().settings).toEqual({ enabled: false, hour: 1, keepDaily: 14, keepWeekly: 8 });
    expect(onSettingsChanged).toHaveBeenCalledTimes(1);
  });

  it('deletes a backup and its record', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/v1/backups/liner-2026-09-29T03-00-00Z.pgdump' });
    expect(res.statusCode).toBe(204);
    expect((await readdir(dir)).filter((f) => f.startsWith('liner-'))).toEqual([]);
  });
});

describe('applyBackupSchedule', () => {
  it('schedules the chosen hour in the container time zone, or removes the schedule', async () => {
    const boss = { schedule: vi.fn(async () => undefined), unschedule: vi.fn(async () => undefined) };
    const service = new BackupService({ databaseUrl: 'postgres://unused/db', env: { BACKUP_DIR: '/nonexistent', TZ: 'Europe/Amsterdam' } });
    await applyBackupSchedule(boss as unknown as PgBoss, service, { enabled: true, hour: 4, keepDaily: 7, keepWeekly: 4 });
    expect(boss.schedule).toHaveBeenCalledWith('backup.nightly', '0 4 * * *', {}, expect.objectContaining({ tz: 'Europe/Amsterdam' }));
    await applyBackupSchedule(boss as unknown as PgBoss, service, { enabled: false, hour: 4, keepDaily: 7, keepWeekly: 4 });
    expect(boss.unschedule).toHaveBeenCalledWith('backup.nightly');
    expect(nightlyCron({ enabled: true, hour: 23, keepDaily: 1, keepWeekly: 0 })).toBe('0 23 * * *');
  });

  it('falls back to the cache folder and says it is not dedicated', () => {
    const service = new BackupService({ databaseUrl: 'postgres://unused/db', env: { CACHE_DIR: '/cache' } });
    expect(service.dir).toBe('/cache/backups');
    expect(service.dedicated).toBe(false);
    expect(service.timeZone).toBe('UTC');
  });
});
