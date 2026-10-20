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
import type { PgBoss } from 'pg-boss';
import type { SessionUser } from '@tagave/shared/auth';
import type { BackupsStatus } from '@tagave/shared';
import { errorHandler } from '../middleware/errorHandler.js';
import { BackupService, applyBackupSchedule, nightlyCron } from '../lib/backupService.js';
import { createBackupRoutes, restoreCommand } from './backups.js';

const owner: SessionUser = { id: 'u1', email: 'o@example.com', displayName: 'Owner', role: 'owner', createdAt: new Date().toISOString() };
const viewer: SessionUser = { ...owner, id: 'u2', role: 'listener' };

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
      // one update with database changes, 0.9.0 to 0.10.0 on 1 Sept
      history: async () => [{ createdAt: new Date('2026-09-01T10:00:00Z'), path: null, fromVersion: '0.9.0', toVersion: '0.10.0' }],
      // A fake dump that finishes when the test says so. Typed here, not left
      // to inference: tsgo's parallel checkers sometimes lose the contextual type.
      run: async ({ dir: out, kind }: { dir: string; kind: 'nightly' | 'manual' }) => {
        await new Promise<void>((r) => { release = r; });
        const file = `tagave-2026-09-29T03-00-00Z${kind === 'manual' ? '' : `-${kind}`}.pgdump`;
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
      settings: { enabled: true, hour: 3, keepDaily: 7, keepWeekly: 4, keepPreUpdate: 3, keepManual: null },
    });
    expect(res.json<BackupsStatus>().kinds).toEqual([
      { kind: 'nightly', count: 0, bytes: 0, newest: null, pendingDelete: { count: 0, bytes: 0, names: [] } },
      { kind: 'pre-migration', count: 0, bytes: 0, newest: null, pendingDelete: { count: 0, bytes: 0, names: [] } },
      { kind: 'manual', count: 0, bytes: 0, newest: null, pendingDelete: { count: 0, bytes: 0, names: [] } },
    ]);
  });

  it('starts a backup at once and shows it running, then listed', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/backups' });
    expect(res.statusCode).toBe(202);
    expect(res.json<BackupsStatus>().running).toBe(true);
    release();
    await vi.waitFor(async () => {
      const list = (await app.inject({ method: 'GET', url: '/api/v1/backups' })).json<BackupsStatus>();
      expect(list.running).toBe(false);
      expect(list.backups).toEqual([expect.objectContaining({ name: 'tagave-2026-09-29T03-00-00Z.pgdump', kind: 'manual', bytes: 15, verified: true })]);
    });
  });

  it('works out the version of a dump without one from the update history; a recorded one wins', async () => {
    let list = (await app.inject({ method: 'GET', url: '/api/v1/backups' })).json<BackupsStatus>();
    expect(list.backups[0]).toMatchObject({ version: '0.10.0', versionInferred: true, toVersion: null });
    const recorded = 'tagave-2026-09-30T03-00-00Z-pre-migration.pgdump';
    await writeFile(join(dir, recorded), 'PGDMP');
    await writeFile(join(dir, `${recorded}.json`), JSON.stringify({ kind: 'pre-migration', verified: true, bytes: 5, appVersion: '0.10.0', toVersion: '0.11.0' }));
    list = (await app.inject({ method: 'GET', url: '/api/v1/backups' })).json<BackupsStatus>();
    expect(list.backups.find((b) => b.name === recorded)).toMatchObject({ version: '0.10.0', versionInferred: false, toVersion: '0.11.0' });
    expect(list.restoreCommand).toContain('restore {file} --yes');
    await rm(join(dir, recorded));
    await rm(join(dir, `${recorded}.json`));
  });

  it('streams a download as an attachment', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/backups/tagave-2026-09-29T03-00-00Z.pgdump/download' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toBe('attachment; filename="tagave-2026-09-29T03-00-00Z.pgdump"');
    expect(res.headers['content-length']).toBe('15');
    expect(res.body).toBe('PGDMP-fake-dump');
  });

  it('refuses names that are not backups, and 404s missing ones', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/backups/..%2Fsecret.pgdump/download' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/v1/backups/backup-settings.json/download' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/v1/backups/tagave-2020-01-01T00-00-00Z.pgdump/download' })).statusCode).toBe(404);
  });

  it('saves settings, validates them and re-applies the schedule', async () => {
    const bad = await app.inject({ method: 'PUT', url: '/api/v1/backups/settings', payload: { enabled: true, hour: 25, keepDaily: 0, keepWeekly: 4 } });
    expect(bad.statusCode).toBe(400);
    expect(onSettingsChanged).not.toHaveBeenCalled();
    // a page from before the per-kind numbers: they keep their saved values
    const ok = await app.inject({ method: 'PUT', url: '/api/v1/backups/settings', payload: { enabled: false, hour: 1, keepDaily: 14, keepWeekly: 8 } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json<BackupsStatus>().settings).toEqual({ enabled: false, hour: 1, keepDaily: 14, keepWeekly: 8, keepPreUpdate: 3, keepManual: null });
    expect(onSettingsChanged).toHaveBeenCalledTimes(1);
  });

  it('keeps 1 to 50 before-update backups and 1 to 100 manual ones, or all manual ones', async () => {
    const base = { enabled: false, hour: 1, keepDaily: 14, keepWeekly: 8 };
    for (const bad of [{ keepPreUpdate: 0 }, { keepPreUpdate: 51 }, { keepManual: 0 }, { keepManual: 101 }, { keepManual: 'all' }]) {
      const res = await app.inject({ method: 'PUT', url: '/api/v1/backups/settings', payload: { ...base, ...bad } });
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
    }
    let res = await app.inject({ method: 'PUT', url: '/api/v1/backups/settings', payload: { ...base, keepPreUpdate: 5, keepManual: 4 } });
    expect(res.json<BackupsStatus>().settings).toMatchObject({ keepPreUpdate: 5, keepManual: 4 });
    res = await app.inject({ method: 'PUT', url: '/api/v1/backups/settings', payload: { ...base, keepPreUpdate: 5, keepManual: null } });
    expect(res.json<BackupsStatus>().settings).toMatchObject({ keepPreUpdate: 5, keepManual: null });
  });

  it('lowering a number deletes nothing on save, and says what goes at the next run', async () => {
    const pre = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'].map((d) => `tagave-${d}T00-00-00Z-pre-migration.pgdump`);
    for (const n of pre) await writeFile(join(dir, n), '1234567890');
    const res = await app.inject({
      method: 'PUT', url: '/api/v1/backups/settings',
      payload: { enabled: true, hour: 3, keepDaily: 7, keepWeekly: 4, keepPreUpdate: 2, keepManual: null },
    });
    expect(res.statusCode).toBe(200);
    for (const n of pre) expect(await readdir(dir)).toContain(n);
    const block = res.json<BackupsStatus>().kinds.find((k) => k.kind === 'pre-migration');
    expect(block).toMatchObject({ count: 4, bytes: 40, newest: '2026-10-04T00:00:00.000Z' });
    // the next update writes one more and keeps 2: the three oldest go
    expect(block?.pendingDelete).toEqual({ count: 3, bytes: 30, names: pre.slice(0, 3) });
    for (const n of pre) await rm(join(dir, n));
  });

  it('deletes a backup and its record', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/v1/backups/tagave-2026-09-29T03-00-00Z.pgdump' });
    expect(res.statusCode).toBe(204);
    expect((await readdir(dir)).filter((f) => f.startsWith('tagave-'))).toEqual([]);
  });
});

describe('restoreCommand', () => {
  it('stops the stack, restores from a one-off container and starts it again in Docker', () => {
    expect(restoreCommand({ TAGAVE_INSTALL_METHOD: 'installer' }).split('\n')).toEqual([
      'docker compose stop app worker-identify worker-files',
      'docker compose run --rm --no-deps app node packages/doctor/dist/cli.js restore {file} --yes',
      'docker compose up -d',
    ]);
  });

  it('runs the doctor directly in a source checkout', () => {
    expect(restoreCommand({ TAGAVE_INSTALL_METHOD: 'source' })).toBe('node packages/doctor/dist/cli.js restore {file} --yes');
  });
});

describe('applyBackupSchedule', () => {
  it('schedules the chosen hour in the container time zone, or removes the schedule', async () => {
    const boss = { schedule: vi.fn(async () => undefined), unschedule: vi.fn(async () => undefined) };
    const service = new BackupService({ databaseUrl: 'postgres://unused/db', env: { BACKUP_DIR: '/nonexistent', TZ: 'Europe/Amsterdam' } });
    await applyBackupSchedule(boss as unknown as PgBoss, service, { enabled: true, hour: 4, keepDaily: 7, keepWeekly: 4, keepPreUpdate: 3, keepManual: null });
    expect(boss.schedule).toHaveBeenCalledWith('backup.nightly', '0 4 * * *', {}, expect.objectContaining({ tz: 'Europe/Amsterdam' }));
    await applyBackupSchedule(boss as unknown as PgBoss, service, { enabled: false, hour: 4, keepDaily: 7, keepWeekly: 4, keepPreUpdate: 3, keepManual: null });
    expect(boss.unschedule).toHaveBeenCalledWith('backup.nightly');
    expect(nightlyCron({ enabled: true, hour: 23, keepDaily: 1, keepWeekly: 0, keepPreUpdate: 3, keepManual: null })).toBe('0 23 * * *');
  });

  it('falls back to the cache folder and says it is not dedicated', () => {
    const service = new BackupService({ databaseUrl: 'postgres://unused/db', env: { CACHE_DIR: '/cache' } });
    expect(service.dir).toBe('/cache/backups');
    expect(service.dedicated).toBe(false);
    expect(service.timeZone).toBe('UTC');
  });
});
