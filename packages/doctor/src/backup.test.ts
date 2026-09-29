import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  backupFileName, countTocEntries, defaultBackupDir, defaultBackupSettings, deleteBackup, isSafeBackupName,
  isoWeekKey, listBackups, ownBackups, parseBackupName, pruneList, readBackupSettings, readBackupStatus,
  recordBackupRun, retentionDeletes, writeBackupSettings, type BackupKind,
} from './backup.js';

describe('backupFileName', () => {
  it('encodes the UTC timestamp without colons or milliseconds', () => {
    expect(backupFileName(new Date('2026-09-08T00:30:00.123Z'))).toBe('liner-2026-09-08T00-30-00Z.pgdump');
  });

  it('sorts chronologically as plain strings', () => {
    const a = backupFileName(new Date('2026-09-08T23:59:59Z'));
    const b = backupFileName(new Date('2026-09-09T00:00:00Z'));
    expect([b, a].sort()).toEqual([a, b]);
  });
});

describe('pruneList', () => {
  const files = [
    'liner-2026-09-03T02-00-00Z.pgdump',
    'liner-2026-09-01T02-00-00Z.pgdump',
    'liner-2026-09-02T02-00-00Z.pgdump',
    'notes.txt',
    'other-2026-09-04T02-00-00Z.pgdump',
  ];

  it('returns the oldest of our dumps beyond keep', () => {
    expect(pruneList(files, 2)).toEqual(['liner-2026-09-01T02-00-00Z.pgdump']);
  });

  it('never lists foreign files', () => {
    expect(pruneList(files, 0)).toEqual([
      'liner-2026-09-01T02-00-00Z.pgdump',
      'liner-2026-09-02T02-00-00Z.pgdump',
      'liner-2026-09-03T02-00-00Z.pgdump',
    ]);
    expect(ownBackups(files)).toHaveLength(3);
  });

  it('prunes nothing when keep covers everything or is negative', () => {
    expect(pruneList(files, 3)).toEqual([]);
    expect(pruneList(files, 10)).toEqual([]);
    expect(pruneList(files, -1)).toEqual([]);
  });
});

describe('countTocEntries', () => {
  it('counts entry lines and ignores the header comments', () => {
    const listing = [
      ';',
      '; Archive created at 2026-09-08 00:30:00 UTC',
      ';     dbname: liner',
      ';',
      '2; 1262 16384 DATABASE - liner liner',
      '215; 1259 16400 TABLE public albums liner',
      '3521; 0 16400 TABLE DATA public albums liner',
      '',
    ].join('\n');
    expect(countTocEntries(listing)).toBe(3);
    expect(countTocEntries('')).toBe(0);
  });
});

describe('defaultBackupDir', () => {
  it('prefers BACKUP_DIR, then LINER_BACKUP_DIR, then CACHE_DIR/backups, then ./backups', () => {
    expect(defaultBackupDir({ BACKUP_DIR: '/backups', LINER_BACKUP_DIR: '/srv/dumps' }, '/app')).toBe('/backups');
    expect(defaultBackupDir({ LINER_BACKUP_DIR: '/srv/dumps', CACHE_DIR: '/cache' }, '/app')).toBe('/srv/dumps');
    expect(defaultBackupDir({ CACHE_DIR: '/cache' }, '/app')).toBe('/cache/backups');
    expect(defaultBackupDir({}, '/app')).toBe('/app/backups');
  });
});

describe('backup kinds in file names', () => {
  const at = new Date('2026-09-29T03:00:00Z');

  it('adds the kind, except for manual dumps (the name older releases wrote)', () => {
    expect(backupFileName(at, 'nightly')).toBe('liner-2026-09-29T03-00-00Z-nightly.pgdump');
    expect(backupFileName(at, 'pre-migration')).toBe('liner-2026-09-29T03-00-00Z-pre-migration.pgdump');
    expect(backupFileName(at)).toBe('liner-2026-09-29T03-00-00Z.pgdump');
  });

  it('reads kind and time back', () => {
    for (const kind of ['nightly', 'manual', 'pre-migration', 'pre-restore'] as BackupKind[]) {
      expect(parseBackupName(backupFileName(at, kind))).toEqual({ kind, createdAt: at });
    }
  });

  it('guesses the kind of a foreign dump and leaves its time to the caller', () => {
    expect(parseBackupName('pre-migrate-0.4.1-20260929.pgdump')).toEqual({ kind: 'pre-migration', createdAt: null });
    expect(parseBackupName('tagave-2026-09-29.pgdump')).toEqual({ kind: 'manual', createdAt: null });
    expect(parseBackupName('notes.txt')).toBeNull();
  });

  it('refuses names with path parts or hidden files', () => {
    expect(isSafeBackupName('liner-2026-09-29T03-00-00Z.pgdump')).toBe(true);
    expect(isSafeBackupName('../etc/passwd.pgdump')).toBe(false);
    expect(isSafeBackupName('a/b.pgdump')).toBe(false);
    expect(isSafeBackupName('.liner.pgdump')).toBe(false);
    expect(isSafeBackupName('liner.pgdump.json')).toBe(false);
  });
});

describe('isoWeekKey', () => {
  it('follows ISO weeks across a year end', () => {
    expect(isoWeekKey('2026-09-28')).toBe('2026-W40'); // Monday
    expect(isoWeekKey('2026-10-04')).toBe('2026-W40'); // Sunday
    expect(isoWeekKey('2027-01-01')).toBe('2026-W53');
    expect(isoWeekKey('2025-12-29')).toBe('2026-W01');
  });
});

describe('retentionDeletes', () => {
  const nightly = (iso: string) => ({ name: backupFileName(new Date(iso), 'nightly'), kind: 'nightly' as BackupKind, createdAt: new Date(iso).toISOString() });

  it('keeps the newest per day for 7 days and the newest per week for 4 weeks', () => {
    // 60 nights, one dump each at 03:00 UTC, newest 2026-09-29 (a Tuesday)
    const entries = Array.from({ length: 60 }, (_, i) => nightly(new Date(Date.UTC(2026, 8, 29 - i, 3)).toISOString()));
    const doomed = new Set(retentionDeletes(entries, { keepDaily: 7, keepWeekly: 4 }, 'UTC'));
    const kept = entries.filter((e) => !doomed.has(e.name)).map((e) => e.createdAt.slice(0, 10));
    expect(kept).toEqual([
      '2026-09-29', '2026-09-28', '2026-09-27', '2026-09-26', '2026-09-25', '2026-09-24', '2026-09-23',
      '2026-09-20', '2026-09-13', // newest of the weeks before (Sundays); this week's newest is already kept
    ]);
  });

  it('keeps only the newest of two dumps on one day', () => {
    const a = nightly('2026-09-29T03:00:00Z');
    const b = nightly('2026-09-29T15:00:00Z');
    expect(retentionDeletes([a, b], { keepDaily: 7, keepWeekly: 0 }, 'UTC')).toEqual([a.name]);
  });

  it('never deletes other kinds', () => {
    const entries = [
      nightly('2026-09-29T03:00:00Z'),
      { name: 'x-pre-migration.pgdump', kind: 'pre-migration' as BackupKind, createdAt: '2026-01-01T00:00:00.000Z' },
      { name: 'x-manual.pgdump', kind: 'manual' as BackupKind, createdAt: '2026-01-01T00:00:00.000Z' },
    ];
    expect(retentionDeletes(entries, { keepDaily: 1, keepWeekly: 0 }, 'UTC')).toEqual([]);
  });

  it('counts days in the given time zone', () => {
    // 23:30 and 00:30 UTC are the same day in New York
    const a = nightly('2026-09-29T00:30:00Z');
    const b = nightly('2026-09-28T23:30:00Z');
    expect(retentionDeletes([a, b], { keepDaily: 7, keepWeekly: 0 }, 'America/New_York')).toEqual([b.name]);
    expect(retentionDeletes([a, b], { keepDaily: 7, keepWeekly: 0 }, 'UTC')).toEqual([]);
  });
});

describe('backups folder', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'tagave-backups-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('lists dumps newest first with kind, size and the verified record', async () => {
    const old = backupFileName(new Date('2026-09-27T03:00:00Z'), 'nightly');
    const fresh = backupFileName(new Date('2026-09-29T03:00:00Z'));
    await writeFile(join(dir, old), 'abc');
    await writeFile(join(dir, old + '.json'), JSON.stringify({ kind: 'nightly', verified: true, bytes: 3 }));
    await writeFile(join(dir, fresh), 'abcdef');
    await writeFile(join(dir, fresh + '.json'), JSON.stringify({ kind: 'manual', verified: true, bytes: 999 })); // size changed since
    await writeFile(join(dir, 'backup-settings.json'), '{}');
    await writeFile(join(dir, '.liner-x.pgdump.partial'), 'half');
    const list = await listBackups(dir);
    expect(list.map((e) => [e.name, e.kind, e.bytes, e.verified])).toEqual([
      [fresh, 'manual', 6, false],
      [old, 'nightly', 3, true],
    ]);
  });

  it('is empty when the folder does not exist yet', async () => {
    expect(await listBackups(join(dir, 'missing'))).toEqual([]);
  });

  it('deletes a dump with its record, and refuses paths', async () => {
    const name = backupFileName(new Date('2026-09-29T03:00:00Z'));
    await writeFile(join(dir, name), 'x');
    await writeFile(join(dir, name + '.json'), '{}');
    await deleteBackup(dir, name);
    expect(await readdir(dir)).toEqual([]);
    await expect(deleteBackup(dir, '../x.pgdump')).rejects.toThrow(/not a backup file name/);
  });

  it('reads defaults until settings are saved, and ignores out-of-range values', async () => {
    expect(await readBackupSettings(dir, {})).toEqual({ enabled: true, hour: 3, keepDaily: 7, keepWeekly: 4 });
    expect(defaultBackupSettings({ BACKUP_NIGHTLY: 'off', BACKUP_HOUR: '1', BACKUP_KEEP_DAILY: '14', BACKUP_KEEP_WEEKLY: 'x' }))
      .toEqual({ enabled: false, hour: 1, keepDaily: 14, keepWeekly: 4 });
    await writeBackupSettings(dir, { enabled: false, hour: 5, keepDaily: 3, keepWeekly: 2 });
    expect(await readBackupSettings(dir, {})).toEqual({ enabled: false, hour: 5, keepDaily: 3, keepWeekly: 2 });
    await writeFile(join(dir, 'backup-settings.json'), JSON.stringify({ hour: 99, keepDaily: 0 }));
    expect(await readBackupSettings(dir, {})).toEqual({ enabled: true, hour: 3, keepDaily: 7, keepWeekly: 4 });
  });

  it('records the last run and the last nightly run separately', async () => {
    const base = { startedAt: 'a', finishedAt: 'b', pruned: [] };
    await recordBackupRun(dir, { ...base, kind: 'nightly', ok: false, file: null, error: 'disk full' });
    await recordBackupRun(dir, { ...base, kind: 'manual', ok: true, file: 'm.pgdump', error: null });
    const status = await readBackupStatus(dir);
    expect(status.lastRun?.kind).toBe('manual');
    expect(status.lastNightly).toMatchObject({ ok: false, error: 'disk full' });
  });
});
