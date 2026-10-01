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

describe('credentials stay out of argv and errors', () => {
  it('splits the password out of the URL', async () => {
    const { splitDatabasePassword } = await import('./backup.js');
    expect(splitDatabasePassword('postgres://liner:s%40cret@db:5432/liner?sslmode=disable')).toEqual({
      url: 'postgres://liner@db:5432/liner?sslmode=disable',
      password: 's@cret',
    });
    expect(splitDatabasePassword('postgres://liner@db/liner')).toEqual({ url: 'postgres://liner@db/liner', password: null });
  });

  it('redacts --dbname and user:pass@ from error text', async () => {
    const { redactSecrets } = await import('./backup.js');
    const msg = redactSecrets('Command failed: pg_dump --file=/b/x --dbname=postgres://liner:hunter2@db:5432/liner');
    expect(msg).not.toMatch(/hunter2/);
    expect(redactSecrets('could not connect to postgres://liner:hunter2@db/liner')).not.toMatch(/hunter2/);
  });

  it('passes the password to pg_dump through PGPASSWORD, never on the command line, and a killed pg_dump does not leak it', async () => {
    const { mkdtemp, writeFile, chmod, readFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { runBackup } = await import('./backup.js');
    const dir = await mkdtemp(join(tmpdir(), 'liner-fakedump-'));
    try {
      const fake = join(dir, 'pg_dump');
      // Records its argv and PGPASSWORD, then dies from a signal with no stderr.
      await writeFile(fake, `#!/bin/sh\necho "$@" > "${dir}/argv"\necho "$PGPASSWORD" > "${dir}/pw"\nkill -9 $$\n`);
      await chmod(fake, 0o755);
      const err = await runBackup({
        databaseUrl: 'postgres://liner:hunter2@db:5432/liner',
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
    expect(isSeparateMount('/no/such/liner/dir')).toBeNull();
  });
});
