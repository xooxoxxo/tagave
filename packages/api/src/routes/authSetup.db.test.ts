/**
 * First-run setup on Better Auth (auth plan §5): the owner, its credential
 * account and the default library are created server-side under an advisory
 * lock; a second or concurrent setup cannot create another owner.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import type { FastifyInstance } from 'fastify';
import type { AuthHandle } from '@tagave/auth';
import { TEST_PUBLIC_URL, buildAuthApp, cookieHeader, cookieJar, createScratchDb, migrateAll, testAuth } from '../testkit/authApp.js';

const url = process.env.TEST_DATABASE_URL;

const owner = {
  email: 'First@Example.com',
  password: 'twelve chars+',
  displayName: 'First Owner',
  contactString: 'first@example.com',
};

describe.skipIf(!url)('setup on Better Auth (integration)', () => {
  let admin: postgres.Sql;
  const dbs: string[] = [];
  const handles: AuthHandle[] = [];
  const apps: FastifyInstance[] = [];

  async function freshApp(): Promise<{ app: FastifyInstance; sql: postgres.Sql }> {
    const db = await createScratchDb(url!, admin);
    dbs.push(db.name);
    await migrateAll(db.url);
    const handle = testAuth(db.url);
    handles.push(handle);
    const app = await buildAuthApp(handle);
    apps.push(app);
    return { app, sql: handle.sql };
  }

  const setup = (app: FastifyInstance, body: object = owner) =>
    app.inject({ method: 'POST', url: '/api/v1/auth/setup', headers: { origin: TEST_PUBLIC_URL }, payload: body });

  beforeAll(() => {
    process.env.ALLOW_INSECURE_HTTP = 'true';
    admin = postgres(url!, { max: 1, onnotice: () => undefined });
  });

  afterAll(async () => {
    for (const app of apps) await app.close();
    for (const h of handles) await h.close();
    for (const name of dbs) await admin.unsafe(`drop database if exists ${name} with (force)`).catch(() => undefined);
    await admin.end({ timeout: 2 });
  });

  it('creates the owner, its credential account and library, and signs it in', async () => {
    const { app, sql } = await freshApp();
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/setup-required' })).json()).toEqual({ setupRequired: true });

    const res = await setup(app);
    expect(res.statusCode).toBe(201);
    const user = res.json().user;
    expect(user).toMatchObject({ email: 'first@example.com', displayName: 'First Owner', role: 'owner' });

    const [row] = await sql`select role, display_name, password_hash from users where id = ${user.id}`;
    expect(row).toMatchObject({ role: 'owner', display_name: 'First Owner' });
    const accounts = await sql`select provider_id, account_id, password from auth_accounts where user_id = ${user.id}`;
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ provider_id: 'credential', account_id: user.id });
    expect(String(accounts[0]!['password'])).toMatch(/^\$argon2id\$/);
    // Mirrored for rollback to 0.6.x during the bridge release.
    expect(row!['password_hash']).toBe(accounts[0]!['password']);
    expect(await sql`select name from libraries where owner_user_id = ${user.id}`).toEqual([{ name: 'My Music Library' }]);

    const jar = cookieJar(res.headers['set-cookie']);
    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: cookieHeader(jar) } });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.id).toBe(user.id);
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/setup-required' })).json()).toEqual({ setupRequired: false });

    // The new owner signs in with the password it chose.
    const signIn = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: { origin: TEST_PUBLIC_URL, 'content-type': 'application/json' },
      payload: { email: owner.email, password: owner.password },
    });
    expect(signIn.statusCode).toBe(200);
  });

  it('refuses a second setup with 409', async () => {
    const { app, sql } = await freshApp();
    expect((await setup(app)).statusCode).toBe(201);
    const again = await setup(app, { ...owner, email: 'second@example.com' });
    expect(again.statusCode).toBe(409);
    expect(await sql`select count(*)::int as n from users`).toEqual([{ n: 1 }]);
  });

  it('creates exactly one owner when two setups race', async () => {
    const { app, sql } = await freshApp();
    const results = await Promise.all([
      setup(app, { ...owner, email: 'a@example.com' }),
      setup(app, { ...owner, email: 'b@example.com' }),
      setup(app, { ...owner, email: 'c@example.com' }),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409, 409]);
    expect(await sql`select count(*)::int as n from users`).toEqual([{ n: 1 }]);
    expect(await sql`select count(*)::int as n from libraries`).toEqual([{ n: 1 }]);
  });

  it('requires a 12-character password', async () => {
    const { app, sql } = await freshApp();
    const res = await setup(app, { ...owner, password: 'short-pass' });
    expect(res.statusCode).toBe(400);
    expect(await sql`select count(*)::int as n from users`).toEqual([{ n: 0 }]);
  });
});
