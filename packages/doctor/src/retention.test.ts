/**
 * Retention per backup kind (Settings › Backups): the --kind flag, the kind
 * in the sidecar, pruning per kind with the newest kept, a lowered number
 * deleting only at the next run (D5), and how dumps without a kind are filed.
 * pg_dump and pg_restore are small shell stand-ins.
 */
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  adoptLegacyPreUpdateKeep,
  backupFileName,
  backupWithRetention,
  defaultBackupSettings,
  kindDeletes,
  listBackups,
  nextNightlyRun,
  parseBackupArgs,
  parseCliBackupKind,
  pruneKind,
  readBackupSettings,
  runRecordedBackup,
  summarizeKinds,
  writeBackupSettings,
  type BackupKind,
  type BackupSettings,
} from './backup.js';

const settings = (over: Partial<BackupSettings> = {}): BackupSettings => ({ ...defaultBackupSettings({}), ...over });
const at = (iso: string, kind: BackupKind = 'manual') => backupFileName(new Date(iso), kind);

describe('backup --kind', () => {
  it('accepts before-update, nightly and manual, and files before-update with the app’s pre-migration dumps', () => {
    expect(parseCliBackupKind('before-update')).toBe('pre-migration');
    expect(parseCliBackupKind('pre-migration')).toBe('pre-migration');
    expect(parseCliBackupKind('nightly')).toBe('nightly');
    expect(parseCliBackupKind('manual')).toBe('manual');
    expect(parseCliBackupKind('pre-restore')).toBeNull();
    expect(parseCliBackupKind('weekly')).toBeNull();
  });

  it('defaults to manual and refuses an unknown kind', () => {
    expect(parseBackupArgs([], '/backups')).toEqual({ ok: true, outDir: '/backups', keep: undefined, kind: 'manual', json: false });
    expect(parseBackupArgs(['--kind', 'before-update', '--json'], '/backups')).toMatchObject({ ok: true, kind: 'pre-migration', json: true });
    expect(parseBackupArgs(['--kind', 'nightly', '--out', '/x', '--keep', '2'], '/b')).toMatchObject({ ok: true, kind: 'nightly', outDir: '/x', keep: 2 });
    expect(parseBackupArgs(['--kind', 'weekly'], '/b')).toMatchObject({ ok: false, error: expect.stringMatching(/before-update, nightly or manual/) });
    expect(parseBackupArgs(['--kind'], '/b')).toMatchObject({ ok: false });
    expect(parseBackupArgs(['--keep', '0'], '/b')).toMatchObject({ ok: false });
  });
});

describe('dumps with a kind', () => {
  let dir: string;
  let out: string;
  let pgDump: string;
  let pgRestore: string;
  const saved = { PG_DUMP: process.env['PG_DUMP'], PG_RESTORE: process.env['PG_RESTORE'] };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tagave-retention-'));
    out = join(dir, 'backups');
    pgDump = join(dir, 'pg_dump');
    pgRestore = join(dir, 'pg_restore');
    // pg_dump writes a few bytes to --file=…; pg_restore --list prints one entry.
    await writeFile(pgDump, '#!/bin/sh\nfor a in "$@"; do case "$a" in --file=*) printf PGDMP > "${a#--file=}" ;; esac; done\n');
    await writeFile(pgRestore, "#!/bin/sh\necho '215; 1259 16385 TABLE public albums tagave'\n");
    await chmod(pgDump, 0o755);
    await chmod(pgRestore, 0o755);
    process.env['PG_DUMP'] = pgDump;
    process.env['PG_RESTORE'] = pgRestore;
  });

  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(dir, { recursive: true, force: true });
  });

  const seed = async (names: string[]) => {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(out, { recursive: true });
    for (const n of names) await writeFile(join(out, n), 'old-dump');
  };

  it('records the kind in the file name and the sidecar', async () => {
    const r = await backupWithRetention({ databaseUrl: 'postgres://x/db', outDir: out, kind: 'pre-migration', now: new Date('2026-10-16T10:00:00Z'), env: {} });
    expect(r.path).toBe(join(out, 'tagave-2026-10-16T10-00-00Z-pre-migration.pgdump'));
    const sidecar = JSON.parse(await readFile(r.path + '.json', 'utf8')) as { kind: string; verified: boolean };
    expect(sidecar).toMatchObject({ kind: 'pre-migration', verified: true });
    expect((await listBackups(out))[0]).toMatchObject({ kind: 'pre-migration', verified: true });
  });

  it('a before-update run prunes before-update dumps by the saved number and leaves the other kinds', async () => {
    const pre = [at('2026-10-01T00:00:00Z', 'pre-migration'), at('2026-10-02T00:00:00Z', 'pre-migration'), at('2026-10-03T00:00:00Z', 'pre-migration')];
    const others = [at('2026-09-01T00:00:00Z'), at('2026-09-01T03:00:00Z', 'nightly'), at('2026-09-01T04:00:00Z', 'pre-restore')];
    await seed([...pre, ...others]);
    await writeBackupSettings(out, settings({ keepPreUpdate: 2 }));
    const r = await backupWithRetention({ databaseUrl: 'postgres://x/db', outDir: out, kind: 'pre-migration', now: new Date('2026-10-16T10:00:00Z'), env: {} });
    expect(r.pruned).toEqual([pre[0], pre[1]]);
    const left = await readdir(out);
    expect(left).toEqual(expect.arrayContaining([pre[2], ...others]));
    expect(left).not.toContain(pre[0]);
  });

  it('manual dumps stay until deleted by default, and go by the saved number once one is set', async () => {
    const manual = [at('2026-10-01T00:00:00Z'), at('2026-10-02T00:00:00Z')];
    await seed(manual);
    let r = await backupWithRetention({ databaseUrl: 'postgres://x/db', outDir: out, kind: 'manual', now: new Date('2026-10-16T10:00:00Z'), env: {} });
    expect(r.pruned).toEqual([]);
    await writeBackupSettings(out, settings({ keepManual: 2 }));
    r = await backupWithRetention({ databaseUrl: 'postgres://x/db', outDir: out, kind: 'manual', now: new Date('2026-10-16T11:00:00Z'), env: {} });
    expect(r.pruned).toEqual([manual[0], manual[1]]);
  });

  it('--keep wins over the saved number', async () => {
    await seed([at('2026-10-01T00:00:00Z', 'nightly')]);
    const r = await backupWithRetention({ databaseUrl: 'postgres://x/db', outDir: out, kind: 'nightly', keep: 5, now: new Date('2026-10-16T03:00:00Z'), env: {} });
    expect(r.pruned).toEqual([]);
  });

  it('a manual "Back up now" prunes manual dumps only, never nightly ones', async () => {
    const nightly = [at('2026-10-01T03:00:00Z', 'nightly'), at('2026-10-02T03:00:00Z', 'nightly')];
    const manual = at('2026-10-01T12:00:00Z');
    await seed([...nightly, manual]);
    const rec = await runRecordedBackup({
      databaseUrl: 'postgres://x/db', dir: out, kind: 'manual', settings: settings({ keepDaily: 1, keepWeekly: 0, keepManual: 1 }),
      timeZone: 'UTC', now: new Date('2026-10-16T10:00:00Z'),
    });
    expect(rec.ok).toBe(true);
    expect(rec.pruned).toEqual([manual]);
    expect(await readdir(out)).toEqual(expect.arrayContaining(nightly));
  });

  it('a failed run deletes nothing', async () => {
    await seed([at('2026-10-01T00:00:00Z'), at('2026-10-02T00:00:00Z')]);
    await writeFile(pgDump, '#!/bin/sh\necho "disk full" >&2\nexit 1\n');
    const rec = await runRecordedBackup({ databaseUrl: 'postgres://x/db', dir: out, kind: 'manual', settings: settings({ keepManual: 1 }) });
    expect(rec).toMatchObject({ ok: false, pruned: [] });
    expect((await readdir(out)).filter((f) => f.endsWith('.pgdump'))).toHaveLength(2);
  });

  it('lowering a number deletes nothing on save; the next run of that kind does it (D5)', async () => {
    const pre = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05'].map((d) => at(`${d}T00:00:00Z`, 'pre-migration'));
    await seed(pre);
    await writeBackupSettings(out, settings({ keepPreUpdate: 2 }));
    expect((await readdir(out)).filter((f) => f.endsWith('.pgdump'))).toHaveLength(5);
    // the page says what goes at the next run: one new dump plus the newest one kept
    const now = new Date('2026-10-16T10:00:00Z');
    const block = summarizeKinds(await listBackups(out), settings({ keepPreUpdate: 2 }), 'UTC', now).find((k) => k.kind === 'pre-migration');
    expect(block?.pendingDelete).toEqual({ count: 4, bytes: 4 * 'old-dump'.length, names: pre.slice(0, 4) });
    const r = await backupWithRetention({ databaseUrl: 'postgres://x/db', outDir: out, kind: 'pre-migration', now, env: {} });
    expect(r.pruned).toEqual(block?.pendingDelete.names);
  });
});

describe('pruning safety', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'tagave-prunesafe-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('never deletes the newest dump of a kind, even with a broken number', async () => {
    const manual = [at('2026-10-01T00:00:00Z'), at('2026-10-02T00:00:00Z')];
    for (const n of manual) await writeFile(join(dir, n), 'x');
    expect(await pruneKind(dir, 'manual', settings({ keepManual: 0 }), 'UTC')).toEqual([manual[0]]);
    expect(await readdir(dir)).toEqual([manual[1]]);
  });

  it('ignores half-written dumps, foreign files and the settings files', async () => {
    const keep = at('2026-10-05T00:00:00Z', 'pre-migration');
    const old = at('2026-10-01T00:00:00Z', 'pre-migration');
    const files = [keep, old, '.tagave-2026-10-06T00-00-00Z-pre-migration.pgdump.partial', 'my-pre-migrate-copy.pgdump', 'backup-settings.json', 'notes.txt'];
    for (const n of files) await writeFile(join(dir, n), 'x');
    expect(await pruneKind(dir, 'pre-migration', settings({ keepPreUpdate: 2 }), 'UTC')).toEqual([]);
    expect(await pruneKind(dir, 'pre-migration', { ...settings(), keepPreUpdate: 1 }, 'UTC')).toEqual([old]);
    expect((await readdir(dir)).sort()).toEqual(files.filter((f) => f !== old).sort());
  });

  it('pre-restore dumps are never pruned', async () => {
    const names = [at('2026-10-01T00:00:00Z', 'pre-restore'), at('2026-10-02T00:00:00Z', 'pre-restore')];
    for (const n of names) await writeFile(join(dir, n), 'x');
    expect(await pruneKind(dir, 'pre-restore', settings({ keepManual: 1 }), 'UTC')).toEqual([]);
  });
});

describe('review fixes', () => {
  let dir: string;
  const saved = { PG_DUMP: process.env['PG_DUMP'], PG_RESTORE: process.env['PG_RESTORE'] };
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tagave-retention-fix-'));
    await writeFile(join(dir, 'pg_dump'), '#!/bin/sh\nfor a in "$@"; do case "$a" in --file=*) printf PGDMP > "${a#--file=}" ;; esac; done\n');
    await writeFile(join(dir, 'pg_restore'), "#!/bin/sh\necho '215; 1259 16385 TABLE public albums tagave'\n");
    await chmod(join(dir, 'pg_dump'), 0o755);
    await chmod(join(dir, 'pg_restore'), 0o755);
    process.env['PG_DUMP'] = join(dir, 'pg_dump');
    process.env['PG_RESTORE'] = join(dir, 'pg_restore');
  });
  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(dir, { recursive: true, force: true });
  });

  it('never deletes a dump whose sidecar kind does not match its name, and counts it under the sidecar kind', async () => {
    const out = join(dir, 'b');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(out);
    // named like a manual dump, recorded as before-update
    const odd = at('2026-10-01T00:00:00Z');
    await writeFile(join(out, odd), 'x');
    await writeFile(join(out, odd + '.json'), JSON.stringify({ kind: 'pre-migration' }));
    const manual = [at('2026-10-02T00:00:00Z'), at('2026-10-03T00:00:00Z')];
    for (const n of manual) await writeFile(join(out, n), 'x');
    const s = settings({ keepManual: 1, keepPreUpdate: 2 });
    const blocks = summarizeKinds(await listBackups(out), s, 'UTC', new Date('2026-10-16T00:00:00Z'));
    expect(blocks.find((b) => b.kind === 'pre-migration')).toMatchObject({ count: 1, pendingDelete: { count: 0 } });
    expect(blocks.find((b) => b.kind === 'manual')?.pendingDelete.names).toEqual(manual);
    expect(await pruneKind(out, 'manual', s, 'UTC')).toEqual([manual[0]]);
    expect(await pruneKind(out, 'pre-migration', { ...s, keepPreUpdate: 1 }, 'UTC')).toEqual([]);
    expect(await readdir(out)).toContain(odd);
  });

  it('keeps the dump it just wrote even when a later-dated one is in the folder', async () => {
    const out = join(dir, 'b');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(out);
    const future = at('2030-01-01T00:00:00Z');
    const older = at('2026-01-01T00:00:00Z');
    for (const n of [future, older]) await writeFile(join(out, n), 'x');
    const rec = await runRecordedBackup({ databaseUrl: 'postgres://x/db', dir: out, kind: 'manual', settings: settings({ keepManual: 1 }), timeZone: 'UTC', now: new Date('2026-10-16T10:00:00Z') });
    expect(rec.ok).toBe(true);
    expect(rec.pruned).toEqual([older]);
    expect(await readdir(out)).toEqual(expect.arrayContaining([future, rec.file!]));
    // the CLI path too
    await writeBackupSettings(out, settings({ keepManual: 1 }));
    const r = await backupWithRetention({ databaseUrl: 'postgres://x/db', outDir: out, kind: 'manual', now: new Date('2026-10-16T11:00:00Z'), env: {} });
    expect(await readdir(out)).toEqual(expect.arrayContaining([future, join(r.path).split('/').pop()!]));
  });

  it('an install with before-update dumps from a release that kept 5 keeps 5, once', async () => {
    for (const d of ['2026-09-01', '2026-09-02']) await writeFile(join(dir, at(`${d}T00:00:00Z`, 'pre-migration')), 'x');
    await writeFile(join(dir, 'backup-settings.json'), JSON.stringify({ hour: 4 }));
    expect(await adoptLegacyPreUpdateKeep(dir, {})).toBe(true);
    expect(await readBackupSettings(dir, {})).toMatchObject({ hour: 4, keepPreUpdate: 5 });
    // saved now: a second call changes nothing, and the page can lower it
    await writeFile(join(dir, 'backup-settings.json'), JSON.stringify({ hour: 4, keepPreUpdate: 2 }));
    expect(await adoptLegacyPreUpdateKeep(dir, {})).toBe(false);
    expect((await readBackupSettings(dir, {})).keepPreUpdate).toBe(2);
  });

  it('a fresh install (no before-update dumps, or only the one just written) gets 3, and an env value wins', async () => {
    expect(await adoptLegacyPreUpdateKeep(join(dir, 'missing'), {})).toBe(false);
    expect(await adoptLegacyPreUpdateKeep(dir, {})).toBe(false);
    expect((await readBackupSettings(dir, {})).keepPreUpdate).toBe(3);
    const first = at('2026-10-16T00:00:00Z', 'pre-migration');
    await writeFile(join(dir, first), 'x');
    expect(await adoptLegacyPreUpdateKeep(dir, {}, first)).toBe(false);
    expect(await adoptLegacyPreUpdateKeep(dir, { TAGAVE_PREMIGRATE_BACKUP_KEEP: '4' })).toBe(false);
    expect((await readBackupSettings(dir, { TAGAVE_PREMIGRATE_BACKUP_KEEP: '4' })).keepPreUpdate).toBe(4);
  });
});

describe('Settings › Backups blocks', () => {
  const entry = (name: string, kind: BackupKind, createdAt: string, bytes = 10) => ({ name, kind, createdAt, bytes, verified: true, version: null, versionInferred: false, toVersion: null });

  it('has nightly, before update and manual always, before restore only when present', () => {
    expect(summarizeKinds([], settings(), 'UTC').map((k) => k.kind)).toEqual(['nightly', 'pre-migration', 'manual']);
    const withRestore = summarizeKinds([entry(at('2026-10-01T00:00:00Z', 'pre-restore'), 'pre-restore', '2026-10-01T00:00:00.000Z')], settings(), 'UTC');
    expect(withRestore.map((k) => k.kind)).toEqual(['nightly', 'pre-migration', 'manual', 'pre-restore']);
    expect(withRestore[3]).toMatchObject({ count: 1, bytes: 10, newest: '2026-10-01T00:00:00.000Z', pendingDelete: { count: 0 } });
  });

  it('counts sizes and the newest per kind', () => {
    const list = [
      entry(at('2026-10-02T00:00:00Z'), 'manual', '2026-10-02T00:00:00.000Z', 100),
      entry(at('2026-10-01T00:00:00Z'), 'manual', '2026-10-01T00:00:00.000Z', 50),
      entry(at('2026-10-03T00:00:00Z', 'pre-migration'), 'pre-migration', '2026-10-03T00:00:00.000Z', 7),
    ];
    const blocks = summarizeKinds(list, settings(), 'UTC');
    expect(blocks.find((b) => b.kind === 'manual')).toMatchObject({ count: 2, bytes: 150, newest: '2026-10-02T00:00:00.000Z' });
    expect(blocks.find((b) => b.kind === 'pre-migration')).toMatchObject({ count: 1, bytes: 7, pendingDelete: { count: 0, bytes: 0 } });
    expect(blocks.find((b) => b.kind === 'nightly')).toMatchObject({ count: 0, bytes: 0, newest: null });
  });

  it('shows what the next nightly run deletes, and nothing when nightly backups are off', () => {
    // seven daily dumps at 03:00 UTC; the next run is 03:00 on the 8th and pushes out the 1st
    const list = Array.from({ length: 7 }, (_, i) => {
      const iso = `2026-10-0${i + 1}T03:00:00Z`;
      return entry(at(iso, 'nightly'), 'nightly', new Date(iso).toISOString());
    });
    const now = new Date('2026-10-07T12:00:00Z');
    const on = summarizeKinds(list, settings({ keepDaily: 7, keepWeekly: 0 }), 'UTC', now).find((b) => b.kind === 'nightly');
    expect(on?.pendingDelete.names).toEqual([list[0]!.name]);
    const off = summarizeKinds(list, settings({ enabled: false, keepDaily: 7, keepWeekly: 0 }), 'UTC', now).find((b) => b.kind === 'nightly');
    expect(off?.pendingDelete.count).toBe(0);
  });

  it('files a dump with no kind in its name or sidecar as manual, so nothing removes it until the owner says so', () => {
    // The updater before it passes --kind wrote tagave-<time>.pgdump, the same name as "Back up now".
    const untagged = entry(at('2026-10-01T00:00:00Z'), 'manual', '2026-10-01T00:00:00.000Z');
    const foreign = entry('my-pre-migrate-copy.pgdump', 'pre-migration', '2026-09-01T00:00:00.000Z');
    const blocks = summarizeKinds([untagged, foreign], settings({ keepPreUpdate: 2 }), 'UTC');
    expect(blocks.find((b) => b.kind === 'manual')).toMatchObject({ count: 1, pendingDelete: { count: 0 } });
    // a foreign dump is listed under the kind its name suggests but never deleted
    expect(kindDeletes([untagged, foreign], 'pre-migration', settings({ keepPreUpdate: 2 }), 'UTC', new Date())).toEqual([]);
  });
});

describe('nextNightlyRun', () => {
  it('is the next whole hour at the chosen time in the time zone', () => {
    expect(nextNightlyRun(3, 'UTC', new Date('2026-10-16T10:20:00Z')).toISOString()).toBe('2026-10-17T03:00:00.000Z');
    expect(nextNightlyRun(3, 'UTC', new Date('2026-10-16T02:59:00Z')).toISOString()).toBe('2026-10-16T03:00:00.000Z');
    // Amsterdam is UTC+2 in October
    expect(nextNightlyRun(3, 'Europe/Amsterdam', new Date('2026-10-16T10:00:00Z')).toISOString()).toBe('2026-10-17T01:00:00.000Z');
  });
});
