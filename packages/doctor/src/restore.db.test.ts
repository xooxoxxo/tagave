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
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultBackupSettings, listBackups, pgDumpBin, pgRestoreBin, readBackupStatus, runBackup, runRecordedBackup } from './backup.js';
import { PgBoss } from 'pg-boss';
import { RestoreRefused, checkActivity, queueThumbSweep, runRestore, sideName, stamp, withDatabase } from './restore.js';

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
  const name = `tagave_rt_${randomBytes(4).toString('hex')}`;
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

  it('records the version and the newest migration in the sidecar', async () => {
    const result = await runBackup({ databaseUrl: scratchUrl, outDir: dir, kind: 'pre-migration', appVersion: '0.10.0', toVersion: '0.11.0', now: new Date('2026-09-01T00:00:00Z') });
    const sidecar = JSON.parse(await readFile(`${result.path}.json`, 'utf8')) as Record<string, unknown>;
    expect(sidecar).toMatchObject({ kind: 'pre-migration', appVersion: '0.10.0', toVersion: '0.11.0', lastMigration: '0001_x.sql' });
    const entry = (await listBackups(dir)).find((e) => e.name === basename(result.path));
    expect(entry).toMatchObject({ version: '0.10.0', versionInferred: false, toVersion: '0.11.0' });
    await rm(result.path);
    await rm(`${result.path}.json`);
  }, 60_000);

  it('records a nightly run and prunes nightly dumps by the saved settings', async () => {
    const record = await runRecordedBackup({ databaseUrl: scratchUrl, dir, kind: 'nightly', settings: { ...defaultBackupSettings({}), keepDaily: 1, keepWeekly: 0 }, now: new Date('2026-01-01T03:00:00Z') });
    expect(record).toMatchObject({ ok: true, kind: 'nightly' });
    const second = await runRecordedBackup({ databaseUrl: scratchUrl, dir, kind: 'nightly', settings: { ...defaultBackupSettings({}), keepDaily: 1, keepWeekly: 0 }, now: new Date('2026-01-02T03:00:00Z') });
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

  it('swap: when the current database cannot be renamed, drops the restored copy and changes nothing', async () => {
    const now = new Date('2026-09-29T03:30:00Z');
    const blocker = sideName(name, `pre_restore_${stamp(now)}`);
    extraDbs.push(blocker);
    await admin.unsafe(`create database ${blocker}`);
    await expect(runRestore({ databaseUrl: scratchUrl, file: dump, mode: 'swap', backupDir: dir, force: true, now }))
      .rejects.toThrow(/could not rename .*nothing was changed/);
    const fresh = sideName(name, `restore_${stamp(now)}`);
    const left = await admin`select 1 from pg_database where datname = ${fresh}`;
    expect(left).toHaveLength(0);
    const conn = await admin`select datallowconn from pg_database where datname = ${name}`;
    expect(conn[0]?.['datallowconn']).toBe(true);
    expect(await rows()).toEqual({ values: ['one'], extraTable: false });
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

  it('backup --keep prunes manual dumps only', async () => {
    await import('node:fs/promises').then((fs) => fs.writeFile(join(dir, 'otherapp-2026.pgdump'), 'x'));
    await runBackup({ databaseUrl: scratchUrl, outDir: dir, kind: 'manual', keep: 1, now: new Date('2026-09-30T00:00:00Z') });
    const list = await listBackups(dir);
    expect(list.filter((e) => e.kind === 'manual' && e.name.startsWith('tagave-'))).toHaveLength(1);
    expect(list.some((e) => e.name === 'otherapp-2026.pgdump')).toBe(true); // not ours: never pruned
    expect(list.filter((e) => e.kind === 'pre-restore').length).toBeGreaterThanOrEqual(2);
    expect(list.filter((e) => e.kind === 'nightly')).toHaveLength(1);
  }, 60_000);

  it('rejects a file that is not a dump before touching anything', async () => {
    const bogus = join(dir, 'bogus.pgdump');
    await import('node:fs/promises').then((fs) => fs.writeFile(bogus, 'not a dump'));
    await expect(runRestore({ databaseUrl: scratchUrl, file: bogus, mode: 'in-place', backupDir: dir })).rejects.toThrow(/pg_restore/);
    expect(await rows()).toEqual({ values: ['one', 'two'], extraTable: true });
  }, 60_000);

  it('queues the cover thumbnail rebuild once the restore is done; a queue that cannot take it does not fail the restore', async () => {
    const asked: string[] = [];
    // the newest manual dump (the first one was pruned by --keep above)
    const latest = (await listBackups(dir)).find((e) => e.kind === 'manual' && e.name.startsWith('tagave-'))!;
    const file = join(dir, latest.name);
    const ok = await runRestore({
      databaseUrl: scratchUrl, file, mode: 'in-place', backupDir: dir, now: new Date('2026-09-30T01:00:00Z'),
      queueThumbSweep: async (u) => { asked.push(u); },
    });
    expect(ok.thumbSweepQueued).toBe(true);
    expect(asked).toEqual([scratchUrl]);
    const failed = await runRestore({
      databaseUrl: scratchUrl, file, mode: 'in-place', backupDir: dir, now: new Date('2026-09-30T02:00:00Z'),
      queueThumbSweep: async () => { throw new Error('no queue'); },
    });
    expect(failed.thumbSweepQueued).toBe(false);
    expect(failed.tocEntries).toBeGreaterThan(0);
  }, 90_000);

  it('queueThumbSweep sends one art.thumbSweep job through pg-boss', async () => {
    const qname = `tagave_q_${randomBytes(4).toString('hex')}`;
    extraDbs.push(qname);
    await admin.unsafe(`create database ${qname}`);
    const qurl = withDatabase(url!, qname);
    const boss = new PgBoss(qurl);
    boss.on('error', () => undefined);
    await boss.start();
    await boss.createQueue('art.thumbSweep', { policy: 'stately' });
    await boss.stop({ graceful: false });
    await queueThumbSweep(qurl);
    await queueThumbSweep(qurl); // deduped by its singleton key
    const sql = postgres(qurl, { max: 1, onnotice: () => undefined });
    try {
      const r = await sql`select count(*)::int as n from pgboss.job where name = 'art.thumbSweep'`;
      expect(r[0]!['n']).toBe(1);
    } finally {
      await sql.end({ timeout: 2 });
    }
  }, 60_000);
});
