import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyRetention, backupFileName, countTocEntries, defaultBackupDir, defaultBackupSettings, deleteBackup, describeExecError,
  isSafeBackupName, isoWeekKey, listBackups, ownBackups, ownKind, parseBackupName, pgConnection, pruneList, readBackupSettings,
  readBackupStatus, recordBackupRun, redactSecrets, retentionDeletes, writeBackupSettings, type BackupKind,
} from './backup.js';

describe('backupFileName', () => {
  it('encodes the UTC timestamp without colons or milliseconds', () => {
    expect(backupFileName(new Date('2026-09-08T00:30:00.123Z'))).toBe('tagave-2026-09-08T00-30-00Z.pgdump');
  });

  it('sorts chronologically as plain strings', () => {
    const a = backupFileName(new Date('2026-09-08T23:59:59Z'));
    const b = backupFileName(new Date('2026-09-09T00:00:00Z'));
    expect([b, a].sort()).toEqual([a, b]);
  });
});

describe('pruneList', () => {
  const files = [
    'tagave-2026-09-03T02-00-00Z.pgdump',
    'tagave-2026-09-01T02-00-00Z.pgdump',
    'tagave-2026-09-02T02-00-00Z.pgdump',
    'notes.txt',
    'other-2026-09-04T02-00-00Z.pgdump',
  ];

  it('returns the oldest of our dumps beyond keep', () => {
    expect(pruneList(files, 2)).toEqual(['tagave-2026-09-01T02-00-00Z.pgdump']);
  });

  it('never lists foreign files', () => {
    expect(pruneList(files, 0)).toEqual([
      'tagave-2026-09-01T02-00-00Z.pgdump',
      'tagave-2026-09-02T02-00-00Z.pgdump',
      'tagave-2026-09-03T02-00-00Z.pgdump',
    ]);
    expect(ownBackups(files)).toHaveLength(3);
  });

  it('prunes nothing when keep covers everything or is negative', () => {
    expect(pruneList(files, 3)).toEqual([]);
    expect(pruneList(files, 10)).toEqual([]);
    expect(pruneList(files, -1)).toEqual([]);
  });

  it('only prunes manual dumps: nightly, pre-migration and pre-restore dumps are left alone', () => {
    const mixed = [
      'tagave-2026-09-01T03-00-00Z-nightly.pgdump',
      'tagave-2026-09-01T04-00-00Z-pre-restore.pgdump',
      'tagave-2026-09-01T05-00-00Z-pre-migration.pgdump',
      'tagave-2026-09-02T02-00-00Z.pgdump',
      'tagave-2026-09-03T02-00-00Z.pgdump',
      'tagave-2026-09-04T03-00-00Z-nightly.pgdump',
    ];
    expect(pruneList(mixed, 1)).toEqual(['tagave-2026-09-02T02-00-00Z.pgdump']);
    expect(pruneList(mixed, 0)).toEqual(['tagave-2026-09-02T02-00-00Z.pgdump', 'tagave-2026-09-03T02-00-00Z.pgdump']);
  });
});

describe('ownKind', () => {
  it('reads only names this app writes, without guessing', () => {
    expect(ownKind('tagave-2026-09-29T03-00-00Z.pgdump')).toBe('manual');
    expect(ownKind('tagave-2026-09-29T03-00-00Z-nightly.pgdump')).toBe('nightly');
    expect(ownKind('tagave-2026-09-29T03-00-00Z-weekly.pgdump')).toBeNull();
    expect(ownKind('otherapp-nightly.pgdump')).toBeNull();
    expect(ownKind('tagave-nightly.pgdump')).toBeNull();
  });
});

describe('secrets in pg_dump / pg_restore errors', () => {
  it('moves the password out of the URL into PGPASSWORD', () => {
    const c = pgConnection('postgres://tagave:s%40cret@db:5432/tagave');
    expect(c.dbname).toBe('postgres://tagave@db:5432/tagave');
    expect(c.env['PGPASSWORD']).toBe('s@cret');
    const q = pgConnection('postgres://tagave@db/tagave?password=hunter2&sslmode=disable');
    expect(q.dbname).not.toContain('hunter2');
    expect(q.env['PGPASSWORD']).toBe('hunter2');
  });

  it('never repeats the command line when the tool gives no stderr', () => {
    const cmd = 'Command failed: pg_dump --dbname=postgres://tagave:hunter2@db/tagave';
    expect(describeExecError(Object.assign(new Error(cmd), { signal: 'SIGKILL', stderr: '' }), 'pg_dump')).not.toContain('hunter2');
    expect(describeExecError(Object.assign(new Error(cmd), { code: 1, stderr: '' }), 'pg_dump')).toBe('pg_dump exited with code 1');
    expect(describeExecError(new Error(cmd), 'pg_dump')).not.toContain('hunter2');
    expect(describeExecError(Object.assign(new Error(cmd), { stderr: 'could not connect to postgres://tagave:hunter2@db/tagave' }), 'pg_dump'))
      .not.toContain('hunter2');
  });

  it('redacts URL passwords and password parameters', () => {
    expect(redactSecrets('x postgresql://u:p@h/d y')).toBe('x postgresql://u:***@h/d y');
    expect(redactSecrets('host=h password=p dbname=d')).toBe('host=h password=*** dbname=d');
  });
});

describe('countTocEntries', () => {
  it('counts entry lines and ignores the header comments', () => {
    const listing = [
      ';',
      '; Archive created at 2026-09-08 00:30:00 UTC',
      ';     dbname: tagave',
      ';',
      '2; 1262 16384 DATABASE - tagave tagave',
      '215; 1259 16400 TABLE public albums tagave',
      '3521; 0 16400 TABLE DATA public albums tagave',
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

describe('credentials stay out of argv and errors', () => {
  it('redacts --dbname and user:pass@ from error text', async () => {
    const { redactSecrets } = await import('./backup.js');
    const msg = redactSecrets('Command failed: pg_dump --file=/b/x --dbname=postgres://tagave:hunter2@db:5432/tagave');
    expect(msg).not.toMatch(/hunter2/);
    expect(redactSecrets('could not connect to postgres://tagave:hunter2@db/tagave')).not.toMatch(/hunter2/);
  });

  it('passes the password to pg_dump through PGPASSWORD, never on the command line, and a killed pg_dump does not leak it', async () => {
    const { mkdtemp, writeFile, chmod, readFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { runBackup } = await import('./backup.js');
    const dir = await mkdtemp(join(tmpdir(), 'tagave-fakedump-'));
    try {
      const fake = join(dir, 'pg_dump');
      // Records its argv and PGPASSWORD, then dies from a signal with no stderr.
      await writeFile(fake, `#!/bin/sh\necho "$@" > "${dir}/argv"\necho "$PGPASSWORD" > "${dir}/pw"\nkill -9 $$\n`);
      await chmod(fake, 0o755);
      const err = await runBackup({
        databaseUrl: 'postgres://tagave:hunter2@db:5432/tagave',
        outDir: join(dir, 'out'),
        pgDump: fake,
      }).catch((e: unknown) => e as Error);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).not.toMatch(/hunter2/);
      expect((err as Error).message).toMatch(/SIGKILL/);
      expect(await readFile(join(dir, 'argv'), 'utf8')).not.toMatch(/hunter2/);
      expect((await readFile(join(dir, 'pw'), 'utf8')).trim()).toBe('hunter2');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('isSeparateMount', () => {
  it('is false for a folder on the same filesystem as the root it is compared with', async () => {
    const { isSeparateMount } = await import('./backup.js');
    const { tmpdir } = await import('node:os');
    expect(isSeparateMount(tmpdir(), tmpdir())).toBe(false);
    expect(isSeparateMount('/no/such/tagave/dir')).toBeNull();
  });
});

describe('pruneBackups', () => {
  it('keeps the newest dumps of one kind and never touches other kinds or foreign files', async () => {
    const { pruneBackups } = await import('./backup.js');
    const dir = await mkdtemp(join(tmpdir(), 'tagave-prune-'));
    try {
      const names = [
        backupFileName(new Date('2026-09-01T00:00:00Z'), 'pre-migration'),
        backupFileName(new Date('2026-09-02T00:00:00Z'), 'pre-migration'),
        backupFileName(new Date('2026-09-03T00:00:00Z'), 'pre-migration'),
        backupFileName(new Date('2026-09-01T00:00:00Z'), 'nightly'),
        'pre-migrate-by-hand.pgdump',
      ];
      for (const n of names) await writeFile(join(dir, n), 'x');
      await writeFile(join(dir, names[0] + '.json'), '{}');
      expect(await pruneBackups(dir, 2, 'pre-migration')).toEqual([names[0]]);
      expect((await readdir(dir)).sort()).toEqual(names.slice(1).sort());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('backup kinds in file names', () => {
  const at = new Date('2026-09-29T03:00:00Z');

  it('adds the kind, except for manual dumps (the name older releases wrote)', () => {
    expect(backupFileName(at, 'nightly')).toBe('tagave-2026-09-29T03-00-00Z-nightly.pgdump');
    expect(backupFileName(at, 'pre-migration')).toBe('tagave-2026-09-29T03-00-00Z-pre-migration.pgdump');
    expect(backupFileName(at)).toBe('tagave-2026-09-29T03-00-00Z.pgdump');
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
    expect(isSafeBackupName('tagave-2026-09-29T03-00-00Z.pgdump')).toBe(true);
    expect(isSafeBackupName('../etc/passwd.pgdump')).toBe(false);
    expect(isSafeBackupName('a/b.pgdump')).toBe(false);
    expect(isSafeBackupName('.tagave.pgdump')).toBe(false);
    expect(isSafeBackupName('tagave.pgdump.json')).toBe(false);
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

  it('never deletes a foreign dump whose name only looks nightly', () => {
    const entries = [
      nightly('2026-09-29T03:00:00Z'),
      { name: 'otherapp-nightly.pgdump', kind: 'nightly' as BackupKind, createdAt: '2026-01-01T00:00:00.000Z' },
      { name: 'tagave-nightly-copy.pgdump', kind: 'nightly' as BackupKind, createdAt: '2026-01-02T00:00:00.000Z' },
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
    await writeFile(join(dir, '.tagave-x.pgdump.partial'), 'half');
    const list = await listBackups(dir);
    expect(list.map((e) => [e.name, e.kind, e.bytes, e.verified])).toEqual([
      [fresh, 'manual', 6, false],
      [old, 'nightly', 3, true],
    ]);
  });

  it('applies retention without touching foreign files in a shared folder', async () => {
    const keep = backupFileName(new Date('2026-09-29T03:00:00Z'), 'nightly');
    const old = backupFileName(new Date('2026-09-20T03:00:00Z'), 'nightly');
    for (const name of [keep, old, 'otherapp-nightly.pgdump', 'tagave-2026-01-01T00-00-00Z-pre-restore.pgdump']) {
      await writeFile(join(dir, name), 'x');
    }
    expect(await applyRetention(dir, { keepDaily: 1, keepWeekly: 0 }, 'UTC')).toEqual([old]);
    expect((await readdir(dir)).sort()).toEqual(['tagave-2026-01-01T00-00-00Z-pre-restore.pgdump', keep, 'otherapp-nightly.pgdump'].sort());
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
    const defaults = { enabled: true, hour: 3, keepDaily: 7, keepWeekly: 4, keepPreUpdate: 3, keepManual: null };
    expect(await readBackupSettings(dir, {})).toEqual(defaults);
    expect(defaultBackupSettings({ BACKUP_NIGHTLY: 'off', BACKUP_HOUR: '1', BACKUP_KEEP_DAILY: '14', BACKUP_KEEP_WEEKLY: 'x' }))
      .toEqual({ ...defaults, enabled: false, hour: 1, keepDaily: 14 });
    await writeBackupSettings(dir, { enabled: false, hour: 5, keepDaily: 3, keepWeekly: 2, keepPreUpdate: 4, keepManual: 10 });
    expect(await readBackupSettings(dir, {})).toEqual({ enabled: false, hour: 5, keepDaily: 3, keepWeekly: 2, keepPreUpdate: 4, keepManual: 10 });
    await writeFile(join(dir, 'backup-settings.json'), JSON.stringify({ hour: 99, keepDaily: 0, keepPreUpdate: 1, keepManual: 0 }));
    expect(await readBackupSettings(dir, {})).toEqual(defaults);
  });

  it('reads settings saved by an older release (no per-kind fields) with the new defaults', async () => {
    await writeFile(join(dir, 'backup-settings.json'), JSON.stringify({ enabled: true, hour: 2, keepDaily: 5, keepWeekly: 1 }));
    expect(await readBackupSettings(dir, {})).toMatchObject({ hour: 2, keepPreUpdate: 3, keepManual: null });
    // a saved null is "until I delete", not "use the default"
    await writeFile(join(dir, 'backup-settings.json'), JSON.stringify({ keepManual: null }));
    expect((await readBackupSettings(dir, {})).keepManual).toBeNull();
  });

  it('takes the before-update default from TAGAVE_PREMIGRATE_BACKUP_KEEP, within 2 to 50, and a saved value wins', async () => {
    expect((await readBackupSettings(dir, { TAGAVE_PREMIGRATE_BACKUP_KEEP: '6' })).keepPreUpdate).toBe(6);
    expect(defaultBackupSettings({ TAGAVE_PREMIGRATE_BACKUP_KEEP: '1' }).keepPreUpdate).toBe(2);
    expect(defaultBackupSettings({ TAGAVE_PREMIGRATE_BACKUP_KEEP: '50' }).keepPreUpdate).toBe(50);
    expect(defaultBackupSettings({ TAGAVE_PREMIGRATE_BACKUP_KEEP: '99' }).keepPreUpdate).toBe(50);
    expect(defaultBackupSettings({ TAGAVE_PREMIGRATE_BACKUP_KEEP: '' }).keepPreUpdate).toBe(3);
    await writeFile(join(dir, 'backup-settings.json'), JSON.stringify({ keepPreUpdate: 2 }));
    expect((await readBackupSettings(dir, { TAGAVE_PREMIGRATE_BACKUP_KEEP: '6' })).keepPreUpdate).toBe(2);
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

// Releases before 0.9 named their dumps liner-<time>[-kind].pgdump. They stay
// this app's own after the rename: listed, sorted by time with the new
// tagave-* ones, pruned and kept by the same rules.
describe('dumps from before the rename (liner-*)', () => {
  const legacy = (iso: string, kind?: string) => `liner-${iso.replace(/:/g, '-')}${kind ? `-${kind}` : ''}.pgdump`;

  it('are recognised by kind and time', () => {
    expect(ownKind(legacy('2026-09-29T03:00:00Z'))).toBe('manual');
    expect(ownKind(legacy('2026-09-29T03:00:00Z', 'nightly'))).toBe('nightly');
    expect(ownKind(legacy('2026-09-29T03:00:00Z', 'pre-migration'))).toBe('pre-migration');
    expect(parseBackupName(legacy('2026-09-29T03:00:00Z', 'pre-restore'))).toEqual({
      kind: 'pre-restore',
      createdAt: new Date('2026-09-29T03:00:00Z'),
    });
    expect(isSafeBackupName(legacy('2026-09-29T03:00:00Z'))).toBe(true);
    expect(ownKind('liner-nightly.pgdump')).toBeNull();
  });

  it('sort by time with the new names, whichever era is newer', () => {
    const files = [
      backupFileName(new Date('2026-10-02T02:00:00Z')),
      legacy('2026-10-03T02:00:00Z'), // a copy put back by hand, newer than a tagave-* one
      legacy('2026-09-30T02:00:00Z'),
      backupFileName(new Date('2026-10-01T02:00:00Z')),
    ];
    expect(ownBackups(files)).toEqual([
      'liner-2026-09-30T02-00-00Z.pgdump',
      'tagave-2026-10-01T02-00-00Z.pgdump',
      'tagave-2026-10-02T02-00-00Z.pgdump',
      'liner-2026-10-03T02-00-00Z.pgdump',
    ]);
    expect(pruneList(files, 2)).toEqual(['liner-2026-09-30T02-00-00Z.pgdump', 'tagave-2026-10-01T02-00-00Z.pgdump']);
  });

  it('are pruned with the new ones, oldest first, and only the kind asked for', async () => {
    const { pruneBackups } = await import('./backup.js');
    const dir = await mkdtemp(join(tmpdir(), 'tagave-prune-eras-'));
    try {
      const old1 = legacy('2026-09-01T00:00:00Z', 'pre-migration');
      const old2 = legacy('2026-09-02T00:00:00Z', 'pre-migration');
      const new1 = backupFileName(new Date('2026-09-03T00:00:00Z'), 'pre-migration');
      const nightly = legacy('2026-08-01T00:00:00Z', 'nightly');
      for (const n of [new1, old2, old1, nightly]) await writeFile(join(dir, n), 'x');
      expect(await pruneBackups(dir, 2, 'pre-migration')).toEqual([old1]);
      expect((await readdir(dir)).sort()).toEqual([nightly, old2, new1].sort());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('list newest first next to the new ones, and nightly retention counts both', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tagave-list-eras-'));
    try {
      const a = legacy('2026-09-28T03:00:00Z', 'nightly');
      const b = backupFileName(new Date('2026-09-29T03:00:00Z'), 'nightly');
      const c = legacy('2026-09-27T03:00:00Z', 'nightly');
      const d = backupFileName(new Date('2026-09-30T03:00:00Z'));
      for (const n of [a, b, c, d]) await writeFile(join(dir, n), 'x');
      expect((await listBackups(dir)).map((e) => e.name)).toEqual([d, b, a, c]);
      expect(await applyRetention(dir, { keepDaily: 2, keepWeekly: 0 }, 'UTC')).toEqual([c]);
      expect((await readdir(dir)).sort()).toEqual([a, b, d].sort());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
