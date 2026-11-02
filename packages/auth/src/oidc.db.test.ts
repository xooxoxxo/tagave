/**
 * The login service's settings in auth_oidc_config (0074): the client secret
 * is stored encrypted, kept when a save leaves it out, re-encrypted by
 * `tagave-doctor reseal`, and a secret that opens with neither APP_SECRET
 * turns the service off instead of failing every sign-in.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { runMigrations } from '@tagave/db';
import { openAuthSql } from './index.js';
import { readOidcSettings, readOidcSettingsView, resealOidcSecret, saveOidcSettings } from './oidc.js';

const url = process.env.TEST_DATABASE_URL;
const OLD = 'a'.repeat(64);
const NEW = 'b'.repeat(64);
const SECRET = 'client-secret-for-test';

describe.skipIf(!url)('login service settings (integration)', () => {
  let admin: postgres.Sql;
  let name: string;
  let sql: postgres.Sql;

  beforeAll(async () => {
    admin = postgres(url!, { max: 1, onnotice: () => undefined });
    name = `tagave_oidc_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
    await admin.unsafe(`create database ${name}`);
    const u = new URL(url!);
    u.pathname = `/${name}`;
    await runMigrations(u.toString(), { log: () => undefined });
    sql = openAuthSql(u.toString(), 2);
  });

  afterAll(async () => {
    await sql?.end({ timeout: 2 });
    await admin.unsafe(`drop database if exists ${name} with (force)`).catch(() => undefined);
    await admin.end({ timeout: 2 });
  });

  const input = { name: 'Zitadel', issuer: 'https://auth.example.com', clientId: 'tagave', enabled: true, joinEnabled: false, joinGroup: null };

  it('stores the secret encrypted and keeps it when a save leaves it out', async () => {
    expect(await readOidcSettingsView(sql)).toBeNull();
    await saveOidcSettings(sql, OLD, { ...input, clientSecret: SECRET }, null);
    const [row] = await sql<Array<{ client_secret: string }>>`select client_secret from auth_oidc_config`;
    expect(row!.client_secret).not.toContain(SECRET);
    expect((await readOidcSettings(sql, OLD)).settings?.clientSecret).toBe(SECRET);

    await saveOidcSettings(sql, OLD, { ...input, name: 'Home login', clientSecret: undefined }, null);
    const read = await readOidcSettings(sql, OLD);
    expect(read.settings).toMatchObject({ name: 'Home login', clientSecret: SECRET, enabled: true });
    expect(await readOidcSettingsView(sql)).toMatchObject({ name: 'Home login', secretSet: true });
    expect(JSON.stringify(await readOidcSettingsView(sql))).not.toContain(SECRET);
  });

  it('a rotated APP_SECRET turns the service off until reseal', async () => {
    const before = await readOidcSettings(sql, NEW);
    expect(before.secretUnreadable).toBe(true);
    expect(before.settings?.enabled).toBe(false);

    expect(await resealOidcSecret(sql, OLD, NEW)).toBe('resealed');
    expect(await resealOidcSecret(sql, OLD, NEW)).toBe('current');
    const after = await readOidcSettings(sql, NEW);
    expect(after).toMatchObject({ secretUnreadable: false, settings: { clientSecret: SECRET, enabled: true } });
    await expect(resealOidcSecret(sql, 'c'.repeat(64), 'd'.repeat(64))).rejects.toThrow(/neither/);
  });

  it('a public client has no secret', async () => {
    await saveOidcSettings(sql, NEW, { ...input, clientSecret: null }, null);
    expect(await readOidcSettings(sql, NEW)).toMatchObject({ secretUnreadable: false, settings: { clientSecret: null, enabled: true } });
    expect(await resealOidcSecret(sql, OLD, NEW)).toBe('none');
  });
});
