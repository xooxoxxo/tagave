import { describe, it, expect } from 'vitest';
import { PreMigrationBackupError, type PreviousBackup, type SchemaState } from '@liner/db';
import {
  backupFolderProblem,
  preMigrationBackup,
  preMigrationKeep,
  skipPreMigrationBackup,
  PREMIGRATE_PREFIX,
} from './premigrate.js';
import type { BackupOptions, BackupResult } from './backup.js';

const state: SchemaState = {
  files: ['0001_a.sql', '0002_b.sql'],
  applied: ['0001_a.sql'],
  pending: ['0002_b.sql'],
  unknown: [],
  newer: [],
  schemaAppVersion: '0.4.1',
  fresh: false,
};
const quiet = () => undefined;

describe('preMigrationBackup', () => {
  it('dumps into LINER_BACKUP_DIR with its own prefix and does not prune before migrating', async () => {
    let seen: BackupOptions | null = null;
    const hook = preMigrationBackup({
      databaseUrl: 'postgres://x/y',
      env: { LINER_BACKUP_DIR: '/backups', LINER_PREMIGRATE_BACKUP_KEEP: '3' },
      log: quiet,
      backup: async (opts): Promise<BackupResult> => {
        seen = opts;
        return { path: '/backups/pre-migrate-1.pgdump', bytes: 2048, tocEntries: 10, pruned: [], durationMs: 5 };
      },
    });
    expect(await hook(state)).toEqual({ status: 'ok', path: '/backups/pre-migrate-1.pgdump', bytes: 2048 });
    expect(seen).toMatchObject({ outDir: '/backups', prefix: PREMIGRATE_PREFIX });
    expect((seen as BackupOptions | null)?.keep).toBeUndefined();
  });

  it('refuses with a plain reason and the override when the backup fails', async () => {
    const hook = preMigrationBackup({
      databaseUrl: 'postgres://x/y',
      env: { LINER_BACKUP_DIR: '/backups' },
      log: quiet,
      backup: async () => {
        throw new Error('pg_dump: could not open output file: No space left on device');
      },
    });
    const err = await hook(state).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PreMigrationBackupError);
    expect((err as Error).message).toMatch(/^Not migrating: the backup before migrating failed \(pg_dump: could not open/);
    expect((err as Error).message).toMatch(/Nothing was changed/);
    expect((err as Error).message).toMatch(/LINER_SKIP_PREMIGRATE_BACKUP=1/);
  });

  it('refuses an empty dump', async () => {
    const hook = preMigrationBackup({
      databaseUrl: 'postgres://x/y',
      env: {},
      log: quiet,
      backup: async () => ({ path: '/b/pre-migrate-1.pgdump', bytes: 0, tocEntries: 0, pruned: [], durationMs: 1 }),
    });
    await expect(hook(state)).rejects.toThrow(/the dump is empty/);
  });

  it('skips only when the override is set, and records that it did', async () => {
    let called = false;
    const hook = preMigrationBackup({
      databaseUrl: 'postgres://x/y',
      env: { LINER_SKIP_PREMIGRATE_BACKUP: '1' },
      log: quiet,
      backup: async () => {
        called = true;
        throw new Error('unreachable');
      },
    });
    expect(await hook(state)).toMatchObject({ status: 'skipped', path: null });
    expect(called).toBe(false);
  });
});

describe('backup folder must be a mount in the app image', () => {
  it('refuses a folder in the container layer, and names the fix', async () => {
    let called = false;
    const hook = preMigrationBackup({
      databaseUrl: 'postgres://x/y',
      env: { LINER_BACKUP_DIR: '/backups', LINER_BACKUP_REQUIRE_MOUNT: '1' },
      log: quiet,
      isMount: () => false,
      backup: async () => {
        called = true;
        throw new Error('unreachable');
      },
    });
    const err = (await hook(state).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(PreMigrationBackupError);
    expect(err.message).toMatch(/^Not migrating: \/backups is not a mounted volume/);
    expect(err.message).toMatch(/re-run the installer/);
    expect(called).toBe(false);
  });

  it('only applies when the image asks for it, or when the folder is mounted', () => {
    expect(backupFolderProblem('/backups', {}, () => false)).toBeNull();
    expect(backupFolderProblem('/backups', { LINER_BACKUP_REQUIRE_MOUNT: '1' }, () => true)).toBeNull();
    expect(backupFolderProblem('/backups', { LINER_BACKUP_REQUIRE_MOUNT: '0' }, () => false)).toBeNull();
    expect(backupFolderProblem('/backups', { LINER_BACKUP_REQUIRE_MOUNT: '1' }, () => false)).toMatch(/not a mounted volume/);
  });
});

describe('a restart after a failed update', () => {
  const prev = (over: Partial<PreviousBackup> = {}): PreviousBackup => ({
    id: 7,
    status: 'ok',
    path: process.execPath, // a file that exists
    bytes: 99,
    fromVersion: '0.4.1',
    toVersion: '0.5.0',
    pending: ['0002_b.sql', '0003_c.sql'],
    createdAt: new Date(),
    ...over,
  });
  // 0002 applied by the failed attempt, 0003 still pending
  const half: SchemaState = {
    ...state,
    files: ['0001_a.sql', '0002_b.sql', '0003_c.sql'],
    applied: ['0001_a.sql', '0002_b.sql'],
    pending: ['0003_c.sql'],
  };
  const noDump = async (): Promise<never> => {
    throw new Error('should not dump');
  };

  it('keeps the first dump of the update instead of dumping the half-migrated database', async () => {
    const hook = preMigrationBackup({ databaseUrl: 'postgres://x/y', env: {}, log: quiet, appVersion: '0.5.0', backup: noDump });
    expect(await hook(half, prev())).toMatchObject({ status: 'reused', path: process.execPath });
  });

  it('dumps again for a different update, or when the first dump is gone', async () => {
    let dumps = 0;
    const backup = async (): Promise<BackupResult> => {
      dumps++;
      return { path: '/b/pre-migrate-2.pgdump', bytes: 1, tocEntries: 1, pruned: [], durationMs: 1 };
    };
    const hook = preMigrationBackup({ databaseUrl: 'postgres://x/y', env: {}, log: quiet, appVersion: '0.5.0', backup });
    expect((await hook(half, prev({ toVersion: '0.4.9' }))).status).toBe('ok');
    expect((await hook(half, prev({ path: '/no/such/pre-migrate.pgdump' }))).status).toBe('ok');
    expect((await hook(half, prev({ status: 'skipped' }))).status).toBe('ok');
    // a migration the earlier attempt did not have pending
    expect((await hook({ ...half, pending: ['0003_c.sql', '0004_d.sql'] }, prev())).status).toBe('ok');
    expect(dumps).toBe(4);
  });
});

describe('env knobs', () => {
  it('reads the override and the retention', () => {
    expect(skipPreMigrationBackup({})).toBe(false);
    expect(skipPreMigrationBackup({ LINER_SKIP_PREMIGRATE_BACKUP: 'true' })).toBe(true);
    expect(skipPreMigrationBackup({ LINER_SKIP_PREMIGRATE_BACKUP: '0' })).toBe(false);
    expect(preMigrationKeep({})).toBe(5);
    expect(preMigrationKeep({ LINER_PREMIGRATE_BACKUP_KEEP: '0' })).toBe(5);
    expect(preMigrationKeep({ LINER_PREMIGRATE_BACKUP_KEEP: '9' })).toBe(9);
  });
});
