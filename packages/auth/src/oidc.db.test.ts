/**
 * The login service's settings in auth_oidc_config (0074): the client secret
 * is stored encrypted, kept when a save leaves it out, re-encrypted by
 * `tagave-doctor reseal`, and a secret that opens with neither APP_SECRET
 * turns the service off instead of failing every sign-in.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import postgres from 'postgres';
import { runMigrations } from '@tagave/db';
import { createAuth, openAuthSql, readAuthEnv } from './index.js';
import { readOidcSettings, readOidcSettingsView, resealOidcSecret, saveOidcSettings } from './oidc.js';

const url = process.env.TEST_DATABASE_URL;
const OLD = 'a'.repeat(64);
const NEW = 'b'.repeat(64);
const SECRET = 'client-secret-for-test';

describe.skipIf(!url)('login service settings (integration)', () => {
  let admin: postgres.Sql;
  let name: string;
  let sql: postgres.Sql;
  let dbUrl: string;

  beforeAll(async () => {
    admin = postgres(url!, { max: 1, onnotice: () => undefined });
    name = `tagave_oidc_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
    await admin.unsafe(`create database ${name}`);
    const u = new URL(url!);
    u.pathname = `/${name}`;
    await runMigrations(u.toString(), { log: () => undefined });
    dbUrl = u.toString();
    sql = openAuthSql(dbUrl, 2);
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

  it('an issuer that never answers holds up one retry at a time, for at most the time limit', async () => {
    // a tarpit: accepts connections, never answers
    const sockets = new Set<import('node:net').Socket>();
    let hits = 0;
    const tarpit = createServer((s) => { hits++; sockets.add(s); s.resume(); s.on('error', () => undefined); s.on('close', () => sockets.delete(s)); });
    await new Promise<void>((r) => tarpit.listen(0, '127.0.0.1', r));
    const issuer = `http://127.0.0.1:${(tarpit.address() as AddressInfo).port}`;
    const h = createAuth({ env: readAuthEnv({ APP_SECRET: NEW, PUBLIC_URL: 'http://localhost:3100' }), databaseUrl: dbUrl, rateLimit: false, maxConnections: 2, oidcDiscoveryTimeoutMs: 400 });
    const warn = console.warn;
    console.warn = () => undefined;
    try {
      await saveOidcSettings(h.sql, NEW, { ...input, issuer, clientSecret: 'x' }, null);
      let t = Date.now();
      const boot = await h.reload();
      expect(boot).toMatchObject({ configured: true, active: false });
      expect(Date.now() - t).toBeLessThan(2000);

      hits = 0;
      t = Date.now();
      const done = await Promise.all(Array.from({ length: 6 }, () => h.retryOidc(0).then(() => Date.now() - t)));
      // one shared retry: one connection, everyone done within one time limit
      expect(hits).toBe(1);
      expect(Math.max(...done)).toBeLessThan(1500);
      // a caller right after it does not start another
      await h.retryOidc(60_000);
      expect(hits).toBe(1);
      // the timed-out request was aborted, not left hanging
      await new Promise((r) => setTimeout(r, 200));
      expect(sockets.size).toBe(0);
      // and sign-in without the service never waited on it
      expect(h.oidcStatus().active).toBe(false);
    } finally {
      console.warn = warn;
      await h.close();
      for (const s of sockets) s.destroy();
      await new Promise((r) => tarpit.close(() => r(undefined)));
    }
  }, 15_000);

  it('a public client has no secret', async () => {
    await saveOidcSettings(sql, NEW, { ...input, clientSecret: null }, null);
    expect(await readOidcSettings(sql, NEW)).toMatchObject({ secretUnreadable: false, settings: { clientSecret: null, enabled: true } });
    expect(await resealOidcSecret(sql, OLD, NEW)).toBe('none');
  });
});
