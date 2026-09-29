/**
 * Backup + restore round trips against the TEST_DATABASE_URL server. Each run
 * works in its own scratch database (created and dropped here), so the shared
 * test database is never renamed or emptied.
 *
 * Needs pg_dump and pg_restore (16, matching the server) on PATH, or PG_DUMP /
 * PG_RESTORE pointing at them; skipped with the reason printed when missing.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listBackups, pgDumpBin, pgRestoreBin, readBackupStatus, runBackup, runRecordedBackup } from './backup.js';
import { RestoreRefused, checkActivity, runRestore, withDatabase } from './restore.js';

const url = process.env.TEST_DATABASE_URL;

function toolsMissing(): string | null {
  for (const bin of [pgDumpBin(), pgRestoreBin()]) {
    try {
      execFileSync(bin, ['--version'], { stdio: 'pipe' });
    } catch {
      return `${bin} is not available (install postgresql-client-16 or set PG_DUMP / PG_RESTORE)`;
    }
  }
  return null;
}

const missing = url ? toolsMissing() : 'TEST_DATABASE_URL is not set';
if (missing) console.warn(`[restore.db.test] skipped: ${missing}`);

describe.skipIf(!!missing)('backup and restore (integration)', () => {
  const name = `liner_rt_${randomBytes(4).toString('hex')}`;
  let admin: ReturnType<typeof postgres>;
  let scratchUrl: string;
  let dir: string;
  const extraDbs: string[] = [];

  const rows = async (dbUrl = scratchUrl) => {
    const sql = postgres(dbUrl, { max: 1, onnotice: () => undefined });
    try {
      const t = await sql`select v from things order by v`;
      const extra = await sql`select to_regclass('public.added_later') as t`;
      return { values: t.map((r) => r['v'] as string), extraTable: !!extra[0]?.['t'] };
    } finally {
      await sql.end({ timeout: 2 });
    }
  };
  const change = async () => {
    const sql = postgres(scratchUrl, { max: 1, onnotice: () => undefined });
    try {
      await sql`insert into things (v) values ('two')`;
      await sql`create table if not exists added_later (id int)`;
    } finally {
      await sql.end({ timeout: 2 });
    }
  };

  beforeAll(async () => {
    admin = postgres(withDatabase(url!, 'postgres'), { max: 1, onnotice: () => undefined });
    await admin.unsafe(`create database ${name}`);
    scratchUrl = withDatabase(url!, name);
    const sql = postgres(scratchUrl, { max: 1, onnotice: () => undefined });
    await sql`create table things (v text primary key)`;
    await sql`insert into things (v) values ('one')`;
    await sql`create table _migrations (name text primary key, applied_at timestamptz not null default now())`;
    await sql`insert into _migrations (name) values ('0000_init.sql'), ('0001_x.sql')`;
    await sql`create schema pgboss`;
    await sql`create table pgboss.job (id int)`;
    await sql.end({ timeout: 2 });
    dir = await mkdtemp(join(tmpdir(), 'tagave-restore-'));
  }, 60_000);

  afterAll(async () => {
    for (const db of [name, ...extraDbs]) await admin.unsafe(`drop database if exists ${db} with (force)`).catch(() => undefined);
    await admin.end({ timeout: 2 });
    await rm(dir, { recursive: true, force: true });
  });

  let dump: string;

  it('writes a verified dump that shows up in the list', async () => {
    const result = await runBackup({ databaseUrl: scratchUrl, outDir: dir, kind: 'manual' });
    dump = result.path;
    expect(result.tocEntries).toBeGreaterThan(0);
    const list = await listBackups(dir);
    expect(list).toEqual([expect.objectContaining({ name: basename(dump), kind: 'manual', verified: true, bytes: result.bytes })]);
  }, 60_000);

  it('records a nightly run and prunes by the policy', async () => {
    const record = await runRecordedBackup({ databaseUrl: scratchUrl, dir, kind: 'nightly', policy: { keepDaily: 1, keepWeekly: 0 }, now: new Date('2026-01-01T03:00:00Z') });
    expect(record).toMatchObject({ ok: true, kind: 'nightly' });
    const second = await runRecordedBackup({ databaseUrl: scratchUrl, dir, kind: 'nightly', policy: { keepDaily: 1, keepWeekly: 0 }, now: new Date('2026-01-02T03:00:00Z') });
    expect(second.pruned).toEqual([record.file]);
    expect((await readBackupStatus(dir)).lastNightly?.file).toBe(second.file);
    // the manual dump is never pruned
    expect((await listBackups(dir)).map((e) => e.kind).sort()).toEqual(['manual', 'nightly']);
  }, 60_000);

  it('records a failed run with the reason', async () => {
    const record = await runRecordedBackup({ databaseUrl: withDatabase(scratchUrl, `${name}_missing`), dir, kind: 'nightly' });
    expect(record.ok).toBe(false);
    expect(record.error).toMatch(/pg_dump/);
    expect((await readBackupStatus(dir)).lastNightly?.ok).toBe(false);
  }, 60_000);

  it('refuses while another session is connected or a worker checked in, unless forced', async () => {
    await change();
    const other = postgres(scratchUrl, { max: 1, onnotice: () => undefined });
    await other`select 1`;
    try {
      expect((await checkActivity(scratchUrl)).connections.length).toBe(1);
      await expect(runRestore({ databaseUrl: scratchUrl, file: dump, mode: 'swap', backupDir: dir })).rejects.toBeInstanceOf(RestoreRefused);
    } finally {
      await other.end({ timeout: 2 });
    }
    const sql = postgres(scratchUrl, { max: 1, onnotice: () => undefined });
    await sql`create table worker_heartbeats (worker_id text primary key, info jsonb, seen_at timestamptz not null default now())`;
    await sql`insert into worker_heartbeats (worker_id, info) values ('worker-1', '{}')`;
    await sql.end({ timeout: 2 });
    await expect(runRestore({ databaseUrl: scratchUrl, file: dump, mode: 'swap', backupDir: dir })).rejects.toThrow(/checked in during the last two minutes/);
  }, 60_000);

  it('swap: restores into a new database and keeps the old one under another name', async () => {
    const now = new Date('2026-09-29T03:00:00Z');
    const result = await runRestore({ databaseUrl: scratchUrl, file: dump, mode: 'swap', backupDir: dir, force: true, now });
    extraDbs.push(result.previousDatabase!);
    expect(result).toMatchObject({ mode: 'swap', database: name, migrationsInDump: 2, latestMigration: '0001_x.sql' });
    expect(await rows()).toEqual({ values: ['one'], extraTable: false });
    // the replaced database still holds the later changes
    expect(await rows(withDatabase(url!, result.previousDatabase!))).toEqual({ values: ['one', 'two'], extraTable: true });
  }, 60_000);

  it('in-place: takes a pre-restore backup, then restores over the data', async () => {
    await change();
    const result = await runRestore({ databaseUrl: scratchUrl, file: dump, mode: 'in-place', backupDir: dir, now: new Date('2026-09-29T04:00:00Z') });
    expect(result.preRestoreBackup && existsSync(result.preRestoreBackup)).toBe(true);
    expect(await rows()).toEqual({ values: ['one'], extraTable: false });
    const kinds = (await listBackups(dir)).map((e) => e.kind);
    expect(kinds).toContain('pre-restore');
    // and the pre-restore dump brings the later state back
    await runRestore({ databaseUrl: scratchUrl, file: result.preRestoreBackup!, mode: 'in-place', backupDir: dir, now: new Date('2026-09-29T05:00:00Z') });
    expect(await rows()).toEqual({ values: ['one', 'two'], extraTable: true });
  }, 90_000);

  it('rejects a file that is not a dump before touching anything', async () => {
    const bogus = join(dir, 'bogus.pgdump');
    await import('node:fs/promises').then((fs) => fs.writeFile(bogus, 'not a dump'));
    await expect(runRestore({ databaseUrl: scratchUrl, file: bogus, mode: 'in-place', backupDir: dir })).rejects.toThrow(/pg_restore/);
    expect(await rows()).toEqual({ values: ['one', 'two'], extraTable: true });
  }, 60_000);
});
