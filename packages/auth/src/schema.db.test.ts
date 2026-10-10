/**
 * The hand-written migrations match what Better Auth expects: every table and
 * column createAuth()'s configuration (core + plugins) maps to exists. This
 * is tagave's stand-in for `npx auth check schema` (Better Auth's migrator is
 * Kysely-only and tagave's migrations are SQL).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { getAuthTables } from 'better-auth/db';
import { runMigrations } from '@liner/db';
import { createAuth, readAuthEnv, type AuthHandle } from './index.js';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('Better Auth schema vs migrations (integration)', () => {
  let admin: postgres.Sql;
  let name: string;
  let dbUrl: string;
  let handle: AuthHandle;

  beforeAll(async () => {
    admin = postgres(url!, { max: 1, onnotice: () => undefined });
    name = `liner_authschema_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
    await admin.unsafe(`create database ${name}`);
    const u = new URL(url!);
    u.pathname = `/${name}`;
    dbUrl = u.toString();
    await runMigrations(dbUrl, { log: () => undefined });
    handle = createAuth({
      env: readAuthEnv({ APP_SECRET: 'e'.repeat(64), PUBLIC_URL: 'http://localhost:3100' }),
      databaseUrl: dbUrl,
      rateLimit: false,
    });
  });

  afterAll(async () => {
    await handle?.close();
    await admin.unsafe(`drop database if exists ${name} with (force)`).catch(() => undefined);
    await admin.end({ timeout: 2 });
  });

  it('has every table and column the auth configuration maps to', async () => {
    const tables = getAuthTables(handle.auth.options);
    const rows = await handle.sql<Array<{ table_name: string; column_name: string }>>`
      select table_name, column_name from information_schema.columns where table_schema = 'public'`;
    const columns = new Map<string, Set<string>>();
    for (const r of rows) {
      if (!columns.has(r.table_name)) columns.set(r.table_name, new Set());
      columns.get(r.table_name)!.add(r.column_name);
    }
    const missing: string[] = [];
    for (const table of Object.values(tables)) {
      const cols = columns.get(table.modelName);
      if (!cols) {
        missing.push(`table ${table.modelName}`);
        continue;
      }
      if (!cols.has('id')) missing.push(`${table.modelName}.id`);
      for (const [field, attr] of Object.entries(table.fields)) {
        const column = attr.fieldName ?? field;
        if (!cols.has(column)) missing.push(`${table.modelName}.${column} (${field})`);
      }
    }
    expect(missing).toEqual([]);
    // Every Better Auth table lives under auth_* except the reused users table.
    for (const t of Object.values(tables)) expect(t.modelName === 'users' || t.modelName.startsWith('auth_')).toBe(true);
  });
});
