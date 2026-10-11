/**
 * Zero lockout across the Better Auth upgrade (auth plan §4, L1 accept):
 * a 0.6.1-shaped database with an argon2id owner and a live `sessionId`
 * cookie is migrated with 0035-0036 (0036 is the auth upgrade); the owner's password and cookie keep
 * working, the users table and every foreign key to it are untouched.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import argon2 from 'argon2';
import postgres from 'postgres';
import type { FastifyInstance } from 'fastify';
import type { AuthHandle } from '@liner/auth';
import {
  TEST_PUBLIC_URL,
  buildAuthApp,
  cookieHeader,
  cookieJar,
  createScratchDb,
  migrateAll,
  migrateUpTo,
  testAuth,
} from '../testkit/authApp.js';

const url = process.env.TEST_DATABASE_URL;
const OWNER_PASSWORD = 'the-0.6.1-owner-password';
const SESSION = 'tagave.session_token';

describe.skipIf(!url)('auth upgrade: zero lockout (integration)', () => {
  let admin: postgres.Sql;
  let db: { url: string; name: string };
  let sql: postgres.Sql;
  let handle: AuthHandle;
  let app: FastifyInstance;

  const ownerId = '0190a0b0-0000-7000-8000-00000000a001';
  const legacySession = '0190a0b0-0000-7000-8000-00000000b001';
  const legacySession2 = '0190a0b0-0000-7000-8000-00000000b002';
  const expiredSession = '0190a0b0-0000-7000-8000-00000000b003';
  const legacyCreatedAt = new Date('2026-09-20T10:00:00Z');
  let ownerHash: string;
  let fksBefore: unknown[];
  let usersColumnsBefore: Array<{ column_name: string; data_type: string }>;

  const fkQuery = () => sql`
    select con.conname, cls.relname as table_name, pg_get_constraintdef(con.oid) as def
      from pg_constraint con
      join pg_class cls on cls.oid = con.conrelid
     where con.contype = 'f' and con.confrelid = 'users'::regclass
       and cls.relname not like 'auth\\_%'
     order by cls.relname, con.conname`;

  beforeAll(async () => {
    admin = postgres(url!, { max: 1, onnotice: () => undefined });
    db = await createScratchDb(url!, admin);
    await migrateUpTo(db.url, '0035');
    sql = postgres(db.url, { max: 2, onnotice: () => undefined });

    // The 0.6.1 owner, exactly as its setup wrote it (argon2 defaults), with
    // two live sessions and an expired one.
    ownerHash = await argon2.hash(OWNER_PASSWORD);
    await sql`insert into users (id, email, display_name, password_hash, role, created_at)
              values (${ownerId}, 'Owner@Example.com', 'Owner', ${ownerHash}, 'owner', '2026-01-02T03:04:05Z')`;
    await sql`insert into libraries (owner_user_id, name, settings) values (${ownerId}, 'My Music Library', '{}')`;
    await sql`insert into sessions (id, user_id, expires_at, created_at, last_seen_at) values
      (${legacySession}, ${ownerId}, now() + interval '20 days', ${legacyCreatedAt}, now()),
      (${legacySession2}, ${ownerId}, now() + interval '20 days', ${legacyCreatedAt}, now()),
      (${expiredSession}, ${ownerId}, now() - interval '1 day', ${legacyCreatedAt}, now() - interval '31 days')`;

    fksBefore = await fkQuery();
    usersColumnsBefore = await sql`
      select column_name, data_type from information_schema.columns
       where table_name = 'users' order by column_name`;

    expect(await migrateAll(db.url)).toEqual(['0035_perf_indexes_artist_list.sql', '0036_better_auth.sql', '0037_tag_plan_archive.sql', '0038_auto_accept_rules.sql']);
    handle = testAuth(db.url);
    app = await buildAuthApp(handle);
  });

  afterAll(async () => {
    await app?.close();
    await handle?.close();
    await sql?.end({ timeout: 2 });
    if (db) await admin.unsafe(`drop database if exists ${db.name} with (force)`).catch(() => undefined);
    await admin?.end({ timeout: 2 });
  });

  it('leaves the users rows and every foreign key to users as they were', async () => {
    expect(await fkQuery()).toEqual(fksBefore);
    const [owner] = await sql`select id, display_name, password_hash, role, created_at from users where id = ${ownerId}`;
    expect(owner).toMatchObject({ id: ownerId, display_name: 'Owner', password_hash: ownerHash, role: 'owner' });
    expect((owner!['created_at'] as Date).toISOString()).toBe('2026-01-02T03:04:05.000Z');
    // Only additions: every 0.6.1 column is still there with its type.
    const after = await sql<Array<{ column_name: string; data_type: string }>>`
      select column_name, data_type from information_schema.columns where table_name = 'users'`;
    for (const col of usersColumnsBefore) expect(after).toContainEqual(col);
    // The credential account carries the argon2id hash verbatim.
    const accounts = await sql`select account_id, provider_id, password from auth_accounts where user_id = ${ownerId}`;
    expect(accounts).toEqual([{ account_id: ownerId, provider_id: 'credential', password: ownerHash }]);
  });

  it('signs the owner in with the old password (e-mail typed in any case)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: { origin: TEST_PUBLIC_URL, 'content-type': 'application/json' },
      payload: { email: 'OWNER@example.com', password: OWNER_PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    const jar = cookieJar(res.headers['set-cookie']);
    expect(jar[SESSION]).toBeTruthy();
    const probe = await app.inject({ method: 'GET', url: '/api/v1/probe', headers: { cookie: cookieHeader(jar) } });
    expect(probe.statusCode).toBe(200);
    expect(probe.json().user).toMatchObject({ id: ownerId, email: 'owner@example.com', displayName: 'Owner', role: 'owner' });
  });

  it('refuses a wrong password', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: { origin: TEST_PUBLIC_URL, 'content-type': 'application/json' },
      payload: { email: 'owner@example.com', password: 'not-the-password' },
    });
    expect(res.statusCode).toBe(401);
    expect(cookieJar(res.headers['set-cookie'])[SESSION]).toBeUndefined();
  });

  it('keeps the 0.6.x SPA working: /api/v1/auth/login wraps Better Auth sign-in', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: TEST_PUBLIC_URL },
      payload: { email: 'owner@example.com', password: OWNER_PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toMatchObject({ id: ownerId, role: 'owner' });
    const jar = cookieJar(res.headers['set-cookie']);
    expect(jar[SESSION]).toBeTruthy();

    const bad = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'owner@example.com', password: 'nope-nope-nope' },
    });
    expect(bad.statusCode).toBe(401);
  });

  it('bridges a live legacy sessionId cookie: same user, signed in on that very request', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: `sessionId=${legacySession}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toMatchObject({ id: ownerId, role: 'owner' });

    const setCookie = res.headers['set-cookie'];
    const raw = Array.isArray(setCookie) ? setCookie : [String(setCookie)];
    expect(raw.some((c) => /^sessionId=;/.test(c))).toBe(true); // legacy cookie cleared
    const jar = cookieJar(setCookie);
    expect(jar[SESSION]).toBeTruthy();
    expect(raw.find((c) => c.startsWith(`${SESSION}=`))).toMatch(/HttpOnly/i);
    expect(raw.find((c) => c.startsWith(`${SESSION}=`))).toMatch(/SameSite=Lax/i);

    // The legacy row is gone; the new session keeps the legacy created_at.
    expect(await sql`select 1 from sessions where id = ${legacySession}`).toHaveLength(0);
    const sessions = await sql`select created_at from auth_sessions where user_id = ${ownerId} order by created_at limit 1`;
    expect((sessions[0]!['created_at'] as Date).toISOString()).toBe(legacyCreatedAt.toISOString());

    // From now on the Better Auth cookie alone is enough.
    const again = await app.inject({ method: 'GET', url: '/api/v1/probe', headers: { cookie: cookieHeader(jar) } });
    expect(again.statusCode).toBe(200);
    expect(again.json().user.id).toBe(ownerId);
  });

  it('bridges parallel first requests once, all of them signed in', async () => {
    const before = await sql`select count(*)::int as n from auth_sessions where user_id = ${ownerId}`;
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        app.inject({ method: 'GET', url: '/api/v1/probe', headers: { cookie: `sessionId=${legacySession2}` } }),
      ),
    );
    for (const r of results) expect(r.statusCode).toBe(200);
    const after = await sql`select count(*)::int as n from auth_sessions where user_id = ${ownerId}`;
    expect(after[0]!['n']).toBe(before[0]!['n'] + 1);
  });

  it('gives an expired legacy cookie a 401, not a bridge', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/probe', headers: { cookie: `sessionId=${expiredSession}` } });
    expect(res.statusCode).toBe(401);
    expect(cookieJar(res.headers['set-cookie'])[SESSION]).toBeUndefined();
    expect(await sql`select 1 from sessions where id = ${expiredSession}`).toHaveLength(0);
  });

  it('ignores an unknown or malformed legacy cookie', async () => {
    for (const value of ['0190a0b0-0000-7000-8000-0000000000ff', 'not-a-uuid']) {
      const res = await app.inject({ method: 'GET', url: '/api/v1/probe', headers: { cookie: `sessionId=${value}` } });
      expect(res.statusCode).toBe(401);
    }
  });

  it('refuses HTTP sign-up (disableSignUp)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      headers: { origin: TEST_PUBLIC_URL, 'content-type': 'application/json' },
      payload: { email: 'intruder@example.com', password: 'a-long-enough-password', name: 'Intruder' },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(await sql`select 1 from users where email = 'intruder@example.com'`).toHaveLength(0);
  });

  it('signs out through Better Auth, and the cookie stops working', async () => {
    const signIn = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: { origin: TEST_PUBLIC_URL, 'content-type': 'application/json' },
      payload: { email: 'owner@example.com', password: OWNER_PASSWORD },
    });
    const jar = cookieJar(signIn.headers['set-cookie']);
    const out = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-out',
      headers: { origin: TEST_PUBLIC_URL, cookie: cookieHeader(jar) },
    });
    expect(out.statusCode).toBe(200);
    const probe = await app.inject({ method: 'GET', url: '/api/v1/probe', headers: { cookie: cookieHeader(jar) } });
    expect(probe.statusCode).toBe(401);
  });

  it('logs out through the legacy wrapper too', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'owner@example.com', password: OWNER_PASSWORD },
    });
    const jar = cookieJar(login.headers['set-cookie']);
    const out = await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie: cookieHeader(jar), origin: TEST_PUBLIC_URL } });
    expect(out.statusCode).toBe(200);
    const probe = await app.inject({ method: 'GET', url: '/api/v1/probe', headers: { cookie: cookieHeader(jar) } });
    expect(probe.statusCode).toBe(401);
  });

  it('heals a user that a rolled-back 0.6.x wrote after 0036 (no credential account)', async () => {
    const { ensureCredentialAccounts } = await import('@liner/auth');
    const hash = await argon2.hash('rollback-era password');
    await sql`insert into users (email, display_name, password_hash) values ('later@example.com', 'Later', ${hash})`;
    expect(await ensureCredentialAccounts(handle.sql)).toBe(1);
    expect(await ensureCredentialAccounts(handle.sql)).toBe(0);
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: { origin: TEST_PUBLIC_URL, 'content-type': 'application/json' },
      payload: { email: 'later@example.com', password: 'rollback-era password' },
    });
    expect(res.statusCode).toBe(200);
  });
});
