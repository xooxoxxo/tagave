import { describe, it, expect } from 'vitest';
import { PreMigrationBackupError, type SchemaState } from '@liner/db';
import { preMigrationBackup, preMigrationKeep, skipPreMigrationBackup, PREMIGRATE_PREFIX } from './premigrate.js';
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
  it('dumps into LINER_BACKUP_DIR with its own prefix and the configured retention', async () => {
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
    expect(seen).toMatchObject({ outDir: '/backups', keep: 3, prefix: PREMIGRATE_PREFIX });
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
