/**
 * Each person's own preferences (0059, user_prefs) against the real server
 * on a scratch database: the theme follows the person (a second session sees
 * it), nobody sees another person's, a bad shape is refused, a call from
 * another site is refused, and the row goes with the person.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import postgres from 'postgres';
import type { AuthHandle } from '@tagave/auth';

const { registerApiRoutes } = await import('../app.js');
const { initAuth } = await import('../middleware/auth.js');
const { TEST_PUBLIC_URL, createScratchDb, migrateAll, testAuth } = await import('../testkit/authApp.js');
const { createTestUser } = await import('../testkit/users.js');
const { initDb } = await import('../db.js');
type TestUser = Awaited<ReturnType<typeof createTestUser>>;

const adminUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!adminUrl)('user prefs: the theme follows the person (integration)', () => {
  let admin: postgres.Sql;
  let db: { url: string; name: string };
  let handle: AuthHandle;
  let sql: postgres.Sql;
  let app: FastifyInstance;
  let anna: TestUser;
  let ben: TestUser;

  const get = (u: TestUser) => app.inject({ method: 'GET', url: '/api/v1/me/prefs', headers: { cookie: u.cookie } });
  const put = (u: TestUser, payload: unknown, origin = TEST_PUBLIC_URL) =>
    app.inject({ method: 'PUT', url: '/api/v1/me/prefs', headers: { cookie: u.cookie, origin }, payload: payload as object });

  beforeAll(async () => {
    admin = postgres(adminUrl!, { max: 1, onnotice: () => undefined });
    db = await createScratchDb(adminUrl!, admin);
    await migrateAll(db.url);
    await initDb(db.url);
    handle = testAuth(db.url);
    initAuth(handle);
    sql = postgres(db.url, { max: 2, onnotice: () => undefined });
    anna = await createTestUser(handle, { role: 'listener' });
    ben = await createTestUser(handle, { role: 'listener' });
    app = Fastify({ logger: false });
    await app.register(fastifyCookie);
    await registerApiRoutes(app, { backupService: { dir: '/nonexistent' } as never });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await handle?.close();
    await sql?.end({ timeout: 2 });
    if (db) await admin.unsafe(`drop database if exists ${db.name} with (force)`).catch(() => undefined);
    await admin?.end({ timeout: 2 });
  });

  it('is null until the person picks a theme', async () => {
    const res = await get(anna);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ theme: null });
  });

  it('keeps the choice, with Custom, for the person only', async () => {
    const theme = { theme: 'custom', custom: { seed: '#3a7d5c', accent2: '#e0573f' } };
    const res = await put(anna, { theme });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ theme });
    expect((await get(anna)).json()).toEqual({ theme });
    expect((await get(ben)).json()).toEqual({ theme: null });

    // another theme keeps Custom as it was
    const moody = { theme: 'moody', custom: theme.custom };
    expect((await put(anna, { theme: moody })).statusCode).toBe(200);
    expect((await get(anna)).json()).toEqual({ theme: moody });
    const rows = await sql`select user_id::text from user_prefs`;
    expect(rows.map((r) => r['user_id'])).toEqual([anna.userId]);
  });

  it('refuses a bad shape and a call from another site', async () => {
    expect((await put(ben, { theme: { theme: 'neon', custom: null } })).statusCode).toBe(400);
    expect((await put(ben, { theme: { theme: 'custom', custom: { seed: 'teal' } } })).statusCode).toBe(400);
    expect((await put(ben, { theme: { theme: 'classic', custom: null }, extra: 1 })).statusCode).toBe(400);
    expect((await put(ben, { theme: { theme: 'classic', custom: null } }, 'https://evil.example')).statusCode).toBe(403);
    expect((await get(ben)).json()).toEqual({ theme: null });
  });

  it('reads a stored row of another shape as no choice', async () => {
    await sql`insert into user_prefs (user_id, theme) values (${ben.userId}, '{"theme":"aurora"}'::jsonb)`;
    expect((await get(ben)).json()).toEqual({ theme: null });
  });

  it('needs a session', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/me/prefs' });
    expect(res.statusCode).toBe(401);
  });

  it('goes with the person', async () => {
    await sql`delete from users where id = ${ben.userId}`;
    expect(await sql`select 1 from user_prefs where user_id = ${ben.userId}`).toHaveLength(0);
  });
});
