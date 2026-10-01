/**
 * Migration safety against a scratch database on TEST_DATABASE_URL's server:
 * the advisory lock, the newer-schema refusal and version stamp, the backup
 * before migrating (a real pg_dump when one is on PATH or in PG_DUMP), and
 * the doctor's view of all three.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import {
  MIGRATION_LOCK_KEY,
  PreMigrationBackupError,
  SchemaTooNewError,
  runMigrations,
} from '@liner/db';
import { checkMigrations } from './checks.js';
import { checkBackups } from './backupCheck.js';
import { migrateOnBoot, PREMIGRATE_PREFIX } from './premigrate.js';
import { remediationFor } from './remediation.js';
import type { BackupOptions, BackupResult } from './backup.js';

const url = process.env.TEST_DATABASE_URL;

function hasPgDump(): boolean {
  try {
    execFileSync(process.env['PG_DUMP'] ?? 'pg_dump', ['--version'], { stdio: 'ignore' });
    execFileSync(process.env['PG_RESTORE'] ?? 'pg_restore', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function scratchDb(admin: postgres.Sql): Promise<{ url: string; name: string }> {
  const name = `liner_mig_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  await admin.unsafe(`create database ${name}`);
  const u = new URL(url!);
  u.pathname = `/${name}`;
  return { url: u.toString(), name };
}

async function migrationsDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'liner-migs-'));
  for (const [name, body] of Object.entries(files)) await writeFile(join(dir, name), body);
  return dir;
}

const quiet = () => undefined;

describe.skipIf(!url)('migration safety (integration)', () => {
  let admin: postgres.Sql;
  const dbs: string[] = [];
  const dirs: string[] = [];

  const fresh = async () => {
    const db = await scratchDb(admin);
    dbs.push(db.name);
    return db.url;
  };
  const dir = async (files: Record<string, string>) => {
    const d = await migrationsDir(files);
    dirs.push(d);
    return d;
  };

  beforeAll(() => {
    admin = postgres(url!, { max: 1, onnotice: () => undefined });
  });

  afterAll(async () => {
    for (const name of dbs) await admin.unsafe(`drop database if exists ${name} with (force)`).catch(() => undefined);
    await admin.end({ timeout: 2 });
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  it('a second run waits for the lock, then finds nothing to do', async () => {
    const db = await fresh();
    const migs = await dir({
      '0001_a.sql': 'create table a (id int); select pg_sleep(0.5);',
      '0002_b.sql': 'create table b (id int);',
    });
    const [r1, r2] = await Promise.all([
      runMigrations(db, { migrationsDir: migs, appVersion: '1.0.0', log: quiet }),
      runMigrations(db, { migrationsDir: migs, appVersion: '1.0.0', log: quiet }),
    ]);
    const applied = [r1.applied, r2.applied].sort((x, y) => y.length - x.length);
    expect(applied[0]).toEqual(['0001_a.sql', '0002_b.sql']);
    expect(applied[1]).toEqual([]);
    expect(r1.waitedForLock || r2.waitedForLock).toBe(true);
  });

  it('blocks while another session holds the lock and says so', async () => {
    const db = await fresh();
    const migs = await dir({ '0001_a.sql': 'create table a (id int);' });
    const holder = postgres(db, { max: 1 });
    const conn = await holder.reserve();
    await conn`select pg_advisory_lock(${MIGRATION_LOCK_KEY}::bigint)`;
    const lines: string[] = [];
    let done = false;
    const run = runMigrations(db, { migrationsDir: migs, log: (m) => lines.push(m) }).then((r) => {
      done = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 600));
    expect(done).toBe(false);
    expect(lines.join('\n')).toMatch(/another tagave process is migrating/);
    await conn`select pg_advisory_unlock(${MIGRATION_LOCK_KEY}::bigint)`;
    const result = await run;
    expect(result.applied).toEqual(['0001_a.sql']);
    conn.release();
    await holder.end({ timeout: 2 });
    // the lock is released afterwards
    const probe = postgres(db, { max: 1 });
    expect((await probe`select pg_try_advisory_lock(${MIGRATION_LOCK_KEY}::bigint) as ok`)[0]?.['ok']).toBe(true);
    await probe.end({ timeout: 2 });
  });

  it('backs up an existing database before pending migrations, and refuses when the backup fails', async () => {
    const db = await fresh();
    const migs = await dir({ '0001_a.sql': 'create table a (id int);' });
    let calls = 0;
    const first = await runMigrations(db, {
      migrationsDir: migs,
      log: quiet,
      beforeApply: async () => {
        calls++;
        return { status: 'ok', path: '/x', bytes: 1 };
      },
    });
    // a new install has nothing to back up
    expect(calls).toBe(0);
    expect(first.backup).toBeNull();

    await writeFile(join(migs, '0002_b.sql'), 'create table b (id int);');
    await expect(
      runMigrations(db, {
        migrationsDir: migs,
        log: quiet,
        beforeApply: async () => {
          throw new PreMigrationBackupError('Not migrating: disk full');
        },
      }),
    ).rejects.toThrow(/Not migrating/);
    const sql = postgres(db, { max: 1 });
    expect((await sql`select name from _migrations order by name`).map((r) => r['name'])).toEqual(['0001_a.sql']);
    expect((await sql`select to_regclass('public.b') as t`)[0]?.['t']).toBeNull();

    const ok = await runMigrations(db, {
      migrationsDir: migs,
      appVersion: '1.1.0',
      log: quiet,
      beforeApply: async (state) => {
        expect(state.pending).toEqual(['0002_b.sql']);
        return { status: 'ok', path: '/backups/pre-migrate-x.pgdump', bytes: 1234 };
      },
    });
    expect(ok.applied).toEqual(['0002_b.sql']);
    const rec = await sql`select status, path, bytes, to_version, pending from _migration_backups`;
    expect(rec).toHaveLength(1);
    expect(rec[0]).toMatchObject({ status: 'ok', path: '/backups/pre-migrate-x.pgdump', to_version: '1.1.0', pending: ['0002_b.sql'] });
    await sql.end({ timeout: 2 });
  });

  it('stamps the version that migrated and refuses an older app', async () => {
    const db = await fresh();
    const migs = await dir({ '0001_a.sql': 'create table a (id int);' });
    await runMigrations(db, { migrationsDir: migs, appVersion: '0.4.1', log: quiet });
    await writeFile(join(migs, '0002_b.sql'), 'create table b (id int);');
    await runMigrations(db, { migrationsDir: migs, appVersion: '0.5.0', log: quiet, beforeApply: async () => ({ status: 'skipped', path: null, bytes: null }) });
    const sql = postgres(db, { max: 1 });
    expect((await sql`select value from _schema_info where key = 'app_version'`)[0]?.['value']).toBe('0.5.0');
    // a patch release with no migration does not raise the stamp
    await runMigrations(db, { migrationsDir: migs, appVersion: '0.5.1', log: quiet });
    expect((await sql`select value from _schema_info where key = 'app_version'`)[0]?.['value']).toBe('0.5.0');
    await expect(runMigrations(db, { migrationsDir: migs, appVersion: '0.4.1', log: quiet })).rejects.toBeInstanceOf(SchemaTooNewError);
    await expect(runMigrations(db, { migrationsDir: migs, appVersion: '0.4.1', log: quiet, allowNewerSchema: true })).resolves.toBeTruthy();
    await sql.end({ timeout: 2 });
  });

  it('the doctor fails a database a newer app migrated, with the matching remediation', async () => {
    const db = await fresh();
    await runMigrations(db, { appVersion: '0.4.1', log: quiet });
    expect((await checkMigrations(db, '0.4.1')).status).toBe('pass');
    const sql = postgres(db, { max: 1 });
    await sql`update _schema_info set value = '9.0.0' where key = 'app_version'`;
    const check = await checkMigrations(db, '0.4.1');
    expect(check.status).toBe('fail');
    expect(check.detail).toMatch(/^Database is newer than this build/);
    expect(remediationFor(check)).toMatch(/newer version of tagave/);
    await sql.end({ timeout: 2 });
  });

  it.skipIf(!hasPgDump())('takes a real, verified pg_dump before migrating and keeps the last N', async () => {
    const db = await fresh();
    const backups = await mkdtemp(join(tmpdir(), 'liner-premig-'));
    dirs.push(backups);
    const migs = await dir({ '0001_a.sql': 'create table a (id int); insert into a values (1);' });
    const env = { ...process.env, LINER_BACKUP_DIR: backups, LINER_PREMIGRATE_BACKUP_KEEP: '2' };
    await migrateOnBoot({ databaseUrl: db, appVersion: '1.0.0', env, log: quiet, migrationsDir: migs });
    for (const n of [2, 3, 4]) {
      await writeFile(join(migs, `000${n}_m.sql`), `create table m${n} (id int);`);
      const r = await migrateOnBoot({ databaseUrl: db, appVersion: `1.0.${n}`, env, log: quiet, migrationsDir: migs });
      expect(r.backup?.status).toBe('ok');
      expect(r.backup?.bytes).toBeGreaterThan(0);
      await new Promise((res) => setTimeout(res, 1100)); // file names carry seconds
    }
    const files = (await readdir(backups)).filter((f) => f.startsWith(PREMIGRATE_PREFIX));
    expect(files).toHaveLength(2);
    const check = await checkBackups(db, { backupDir: backups });
    expect(check.status).toBe('pass');
    expect(check.detail).toMatch(/last backup before an update to 1\.0\.4/);
  }, 60_000);

  it('a failed update keeps its first dump through restarts, and prunes only after success', async () => {
    const db = await fresh();
    const backups = await mkdtemp(join(tmpdir(), 'liner-premig-retry-'));
    dirs.push(backups);
    // Three dumps from earlier updates; keep 2.
    for (const d of ['2026-01-01', '2026-02-01', '2026-03-01']) {
      await writeFile(join(backups, `${PREMIGRATE_PREFIX}${d}T00-00-00Z.pgdump`), 'old');
    }
    const env = { LINER_BACKUP_DIR: backups, LINER_PREMIGRATE_BACKUP_KEEP: '2' };
    const migs = await dir({ '0001_a.sql': 'create table a (id int);' });
    await migrateOnBoot({ databaseUrl: db, appVersion: '1.0.0', env, log: quiet, migrationsDir: migs });

    await writeFile(join(migs, '0002_b.sql'), 'create table b (id int);');
    await writeFile(join(migs, '0003_c.sql'), 'this is not sql;');
    let dumps = 0;
    const backup = async (o: BackupOptions): Promise<BackupResult> => {
      dumps++;
      const p = join(o.outDir, `${o.prefix}2026-09-0${dumps}T00-00-00Z.pgdump`);
      await writeFile(p, 'dump');
      return { path: p, bytes: 4, tocEntries: 1, pruned: [], durationMs: 1 };
    };
    const boot = () => migrateOnBoot({ databaseUrl: db, appVersion: '1.1.0', env, log: quiet, migrationsDir: migs, backup });

    // 0002 applies, 0003 fails: three restarts in a row.
    for (let i = 0; i < 3; i++) await expect(boot()).rejects.toThrow();
    expect(dumps).toBe(1);
    const first = join(backups, `${PREMIGRATE_PREFIX}2026-09-01T00-00-00Z.pgdump`);
    expect((await readdir(backups)).filter((f) => f.startsWith(PREMIGRATE_PREFIX))).toHaveLength(4); // nothing pruned
    const sql = postgres(db, { max: 1 });
    const rows = await sql`select path, pending from _migration_backups order by id`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ path: first, pending: ['0002_b.sql', '0003_c.sql'] });

    // Fixed: the run succeeds, still on the first dump, then prunes to the newest 2.
    await writeFile(join(migs, '0003_c.sql'), 'create table c (id int);');
    const ok = await boot();
    expect(ok.applied).toEqual(['0003_c.sql']);
    expect(ok.backup).toMatchObject({ status: 'reused', path: first });
    expect(dumps).toBe(1);
    expect((await readdir(backups)).filter((f) => f.startsWith(PREMIGRATE_PREFIX)).sort()).toEqual([
      `${PREMIGRATE_PREFIX}2026-03-01T00-00-00Z.pgdump`,
      `${PREMIGRATE_PREFIX}2026-09-01T00-00-00Z.pgdump`,
    ]);
    expect(await sql`select count(*)::int as n from _migration_backups`).toEqual([{ n: 1 }]);
    await sql.end({ timeout: 2 });
  });

  it('the backups check warns when the folder cannot take a file', async () => {
    const db = await fresh();
    const check = await checkBackups(db, { backupDir: '/proc/liner-cannot-write-here', pgDump: process.execPath });
    expect(check.status).toBe('warn');
    expect(check.detail).toMatch(/not writable/);
    expect(remediationFor(check)).toMatch(/refuses to update/);
  });
});
