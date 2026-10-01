/**
 * The worker's skew rules against a scratch database on TEST_DATABASE_URL's
 * server: wait while the app has not migrated, refuse a newer database.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { waitForCompatibleSchema, WorkerSchemaError, schemaWaitMs } from './schemaGuard.js';

const url = process.env.TEST_DATABASE_URL;
const files = ['0000_init.sql', '0001_a.sql', '0002_b.sql'];
const log = { info: () => undefined, warn: () => undefined };

describe.skipIf(!url)('worker schema guard (integration)', () => {
  let admin: postgres.Sql;
  let sql: postgres.Sql;
  const name = `liner_wguard_${randomUUID().replace(/-/g, '').slice(0, 12)}`;

  beforeAll(async () => {
    admin = postgres(url!, { max: 1, onnotice: () => undefined });
    await admin.unsafe(`create database ${name}`);
    const u = new URL(url!);
    u.pathname = `/${name}`;
    sql = postgres(u.toString(), { max: 2, onnotice: () => undefined });
  });

  afterAll(async () => {
    await sql.end({ timeout: 2 });
    await admin.unsafe(`drop database if exists ${name} with (force)`);
    await admin.end({ timeout: 2 });
  });

  it('waits for the app to apply the migrations it needs, then starts', async () => {
    const sleeps: number[] = [];
    const verdict = await waitForCompatibleSchema(sql, {
      version: '0.5.0',
      files,
      log,
      maxWaitMs: 60_000,
      sleep: async (ms) => {
        sleeps.push(ms);
        // the app migrates while the worker waits
        if (sleeps.length === 1) {
          await sql`create table _migrations (name text primary key, applied_at timestamptz not null default now())`;
          await sql`insert into _migrations (name) values ('0000_init.sql'), ('0001_a.sql')`;
        }
        if (sleeps.length === 2) await sql`insert into _migrations (name) values ('0002_b.sql')`;
      },
    });
    expect(verdict.verdict).toBe('ok');
    expect(sleeps).toEqual([2_000, 4_000]);
  });

  it('gives up after the wait budget with a plain message', async () => {
    let t = 0;
    const err = await waitForCompatibleSchema(sql, {
      version: '0.5.0',
      files: [...files, '0003_c.sql'],
      log,
      maxWaitMs: 10_000,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkerSchemaError);
    expect((err as Error).message).toMatch(/gave up after 10s waiting for the app to update the database: 1 migration\(s\) not applied yet \(0003_c\.sql\)/);
  });

  it('refuses a database migrated by a newer app, unless told to run anyway', async () => {
    await sql`create table _schema_info (key text primary key, value text not null, updated_at timestamptz not null default now())`;
    await sql`insert into _schema_info (key, value) values ('app_version', '0.6.0')`;
    const err = await waitForCompatibleSchema(sql, { version: '0.5.0', files, log, sleep: async () => undefined }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkerSchemaError);
    expect((err as Error).message).toMatch(/^This worker \(tagave 0\.5\.0\) will not run: the database was migrated by tagave 0\.6\.0/);
    const allowed = await waitForCompatibleSchema(sql, { version: '0.5.0', files, log, allowSkew: true });
    expect(allowed.verdict).toBe('newer');
    await sql`delete from _schema_info`;
  });

  it('refuses a ledger with files past its own, even at the same version', async () => {
    await sql`insert into _migrations (name) values ('0009_future.sql')`;
    await expect(waitForCompatibleSchema(sql, { version: '0.5.0', files, log, sleep: async () => undefined })).rejects.toThrow(
      /migration\(s\) this build does not know \(0009_future\.sql\)/,
    );
    await sql`delete from _migrations where name = '0009_future.sql'`;
  });

  it('reads the wait budget from the environment', () => {
    expect(schemaWaitMs({})).toBe(900_000);
    expect(schemaWaitMs({ LINER_SCHEMA_WAIT_SECONDS: '30' })).toBe(30_000);
  });
});
