import { describe, expect, it } from 'vitest';
import { backupFileName, countTocEntries, defaultBackupDir, ownBackups, pruneList } from './backup.js';

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
  it('prefers LINER_BACKUP_DIR, then CACHE_DIR/backups, then ./backups', () => {
    expect(defaultBackupDir({ LINER_BACKUP_DIR: '/srv/dumps', CACHE_DIR: '/cache' }, '/app')).toBe('/srv/dumps');
    expect(defaultBackupDir({ CACHE_DIR: '/cache' }, '/app')).toBe('/cache/backups');
    expect(defaultBackupDir({}, '/app')).toBe('/app/backups');
  });
});
