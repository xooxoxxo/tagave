import { describe, expect, it } from 'vitest';
import { firstBackupSinceSql, ownDumpReason, parseLastBackup, parseRecordedDump, skipsPreMigrationBackup } from './rollback-dump.js';

describe('the backup record', () => {
  it('reads the newest record, or its absence', () => {
    expect(parseLastBackup('12|ok|0.9.0\n')).toEqual({ maxId: 12, status: 'ok', toVersion: '0.9.0' });
    expect(parseLastBackup('0||')).toEqual({ maxId: 0, status: null, toVersion: null });
    expect(parseLastBackup('3|skipped|')).toEqual({ maxId: 3, status: 'skipped', toVersion: null });
    expect(parseLastBackup('')).toBeNull();
    expect(parseLastBackup('ERROR: relation does not exist')).toBeNull();
  });

  it('reads a recorded dump', () => {
    expect(parseRecordedDump('13|ok|/backups/tagave-2026-10-16T10-00-00Z-pre-migration.pgdump')).toEqual({
      id: 13,
      status: 'ok',
      path: '/backups/tagave-2026-10-16T10-00-00Z-pre-migration.pgdump',
    });
    expect(parseRecordedDump('14|skipped|')).toEqual({ id: 14, status: 'skipped', path: null });
    expect(parseRecordedDump('')).toBeNull();
  });

  it('asks only for rows above a whole, non-negative id', () => {
    expect(firstBackupSinceSql(12)).toContain('where id > 12 order by id limit 1');
    expect(firstBackupSinceSql(-4.5)).toContain('where id > 0 ');
    expect(firstBackupSinceSql(3)).not.toContain('"');
  });
});

describe('whether the updater takes a dump of its own', () => {
  const ENV = 'TAGAVE_VERSION=0.9.0\n';

  it('does not when the new app will take one', () => {
    expect(ownDumpReason(ENV, { maxId: 4, status: 'ok', toVersion: '0.9.0' }, '0.10.0')).toBeNull();
    expect(ownDumpReason(ENV, { maxId: 0, status: null, toVersion: null }, '0.10.0')).toBeNull();
    // no table yet: the new app creates it, then dumps
    expect(ownDumpReason(ENV, undefined, '0.10.0')).toBeNull();
    // a failed earlier attempt whose backup failed: the app takes a fresh one
    expect(ownDumpReason(ENV, { maxId: 4, status: 'skipped', toVersion: '0.10.0' }, '0.10.0')).toBeNull();
  });

  it('does when the app migrates without one, by either name', () => {
    expect(ownDumpReason(`${ENV}TAGAVE_SKIP_PREMIGRATE_BACKUP=1\n`, undefined, '0.10.0')).toMatch(/TAGAVE_SKIP_PREMIGRATE_BACKUP is set/);
    expect(skipsPreMigrationBackup('LINER_SKIP_PREMIGRATE_BACKUP=yes\n')).toBe(true);
    expect(skipsPreMigrationBackup('TAGAVE_SKIP_PREMIGRATE_BACKUP=0\n')).toBe(false);
  });

  it('does when the app would reuse an older attempt, or nothing can be read', () => {
    expect(ownDumpReason(ENV, { maxId: 4, status: 'ok', toVersion: '0.10.0' }, '0.10.0')).toMatch(/earlier attempt at 0\.10\.0/);
    expect(ownDumpReason(ENV, null, '0.10.0')).toMatch(/cannot be read/);
  });
});
