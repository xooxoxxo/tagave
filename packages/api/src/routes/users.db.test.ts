/**
 * People on one install, against a scratch database with real Better Auth
 * sessions: invites and set-password links (one use, expiry, revoke),
 * roles and the "at least one owner" rule, turning an account off, removing
 * it with or without its data, step-up on the sensitive changes, and the
 * household model (everyone reads the shared library; per-person data stays
 * per person).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import type { AuthHandle } from '@tagave/auth';
import type { InviteLinkResponse, UsersOverview } from '@tagave/shared';
import { registerApiRoutes } from '../app.js';
import { initAuth } from '../middleware/auth.js';
import { TEST_PUBLIC_URL, cookieHeader, cookieJar, createScratchDb, migrateAll, testAuth } from '../testkit/authApp.js';
import { createTestUser, type TestUser } from '../testkit/users.js';
import { resetUserRouteLimits } from './users.js';
import { resetInviteRouteLimits } from './invites.js';

const adminUrl = process.env.TEST_DATABASE_URL;
const NEW_PASSWORD = 'a brand new passphrase';

describe.skipIf(!adminUrl)('Settings › Users and invite links (integration)', () => {
  let admin: postgres.Sql;
  let db: { url: string; name: string };
  let handle: AuthHandle;
  let sql: postgres.Sql;
  let app: FastifyInstance;
  let owner: TestUser;
  let libraryId: string;

  const headers = (cookie?: string) => ({ origin: TEST_PUBLIC_URL, ...(cookie ? { cookie } : {}) });
  const as = (u: TestUser | undefined, method: string, url: string, payload?: unknown) =>
    app.inject({ method: method as never, url: `/api/v1${url}`, headers: headers(u?.cookie), ...(payload !== undefined ? { payload: payload as object } : {}) });

  async function invite(email: string, role: 'owner' | 'editor' | 'listener'): Promise<{ token: string; body: InviteLinkResponse }> {
    const res = await as(owner, 'POST', '/users/invites', { email, role });
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json() as InviteLinkResponse;
    return { token: body.link.split('/invite/')[1]!, body };
  }

  async function accept(token: string, payload: object = { name: 'Deniz', password: 'twelve chars plus' }) {
    return app.inject({ method: 'POST', url: `/api/v1/invites/${token}/accept`, headers: headers(), payload });
  }

  async function signIn(email: string, password: string) {
    return app.inject({ method: 'POST', url: '/api/auth/sign-in/email', headers: { ...headers(), 'content-type': 'application/json' }, payload: { email, password } });
  }

  /** Make a session older than the five-minute step-up window. */
  const ageSession = (userId: string) => sql`update auth_sessions set created_at = now() - interval '10 minutes' where user_id = ${userId}`;

  beforeAll(async () => {
    admin = postgres(adminUrl!, { max: 1, onnotice: () => undefined });
    db = await createScratchDb(adminUrl!, admin);
    await migrateAll(db.url);
    handle = testAuth(db.url);
    sql = handle.sql;
    initAuth(handle);
    const { initDb } = await import('../db.js');
    await initDb(db.url);
    owner = await createTestUser(handle, { role: 'owner', name: 'Ada Owner' });
    libraryId = (await sql<{ id: string }[]>`
      insert into libraries (owner_user_id, name, settings) values (${owner.userId}, 'Shared', '{}') returning id`)[0]!.id;
    app = Fastify({ logger: false });
    await app.register(fastifyCookie);
    await registerApiRoutes(app, { backupService: { dir: '/nonexistent' } as never });
    await app.ready();
  }, 60_000);

  beforeEach(() => {
    resetUserRouteLimits();
    resetInviteRouteLimits();
  });

  afterAll(async () => {
    await app?.close();
    const { getSql } = await import('../db.js');
    await getSql().end({ timeout: 2 }).catch(() => undefined);
    await handle?.close();
    if (db) await admin.unsafe(`drop database if exists ${db.name} with (force)`).catch(() => undefined);
    await admin?.end({ timeout: 2 });
  });

  it('an invite link makes one account, once, with the invited role', async () => {
    const { token, body } = await invite('Deniz@Example.com', 'listener');
    expect(body.invite).toMatchObject({ purpose: 'invite', email: 'deniz@example.com', role: 'listener', expired: false });
    expect(body.link).toBe(`${TEST_PUBLIC_URL}/invite/${token}`);
    // only the hash is stored
    expect(await sql`select 1 from user_invites where token_hash = ${token}`).toHaveLength(0);

    const lookup = await app.inject({ method: 'GET', url: `/api/v1/invites/${token}` });
    expect(lookup.statusCode).toBe(200);
    expect(lookup.json()).toMatchObject({ purpose: 'invite', email: 'deniz@example.com', role: 'listener' });

    expect((await accept(token, { name: 'Deniz', password: 'short' })).statusCode).toBe(400);
    const ok = await accept(token);
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json().user).toMatchObject({ email: 'deniz@example.com', displayName: 'Deniz', role: 'listener' });
    const cookie = cookieHeader(cookieJar(ok.headers['set-cookie']));
    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: headers(cookie) });
    expect(me.json().user).toMatchObject({ role: 'listener' });

    // one use
    expect((await accept(token)).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/v1/invites/${token}` })).statusCode).toBe(404);
    // the address is taken now
    expect((await as(owner, 'POST', '/users/invites', { email: 'deniz@example.com', role: 'editor' })).statusCode).toBe(409);
  });

  it('a new invite to the same address replaces the open one; revoked and expired links are dead', async () => {
    const first = await invite('sam@example.com', 'editor');
    const second = await invite('sam@example.com', 'listener');
    expect((await app.inject({ method: 'GET', url: `/api/v1/invites/${first.token}` })).statusCode).toBe(404);
    expect((await as(owner, 'DELETE', `/users/invites/${second.body.invite.id}`)).statusCode).toBe(204);
    expect((await accept(second.token)).statusCode).toBe(404);

    const third = await invite('sam@example.com', 'listener');
    await sql`update user_invites set expires_at = now() - interval '1 minute' where id = ${third.body.invite.id}`;
    expect((await accept(third.token)).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/v1/invites/not-a-real-token-at-all-xx' })).statusCode).toBe(404);
  });

  it('asks the owner to confirm it is them for invites, role changes, removal and resets', async () => {
    const listener = await createTestUser(handle, { role: 'listener' });
    await ageSession(owner.userId);
    try {
      for (const [method, url, payload] of [
        ['POST', '/users/invites', { email: 'later@example.com', role: 'listener' }],
        ['PATCH', `/users/${listener.userId}`, { role: 'editor' }],
        ['POST', `/users/${listener.userId}/reset-sign-in`, {}],
        ['DELETE', `/users/${listener.userId}`, { data: 'keep' }],
      ] as const) {
        const res = await as(owner, method, url, payload);
        expect(res.statusCode, `${method} ${url}`).toBe(403);
        expect(res.json().title).toBe('Step-up required');
      }
      // listing and revoking need no fresh sign-in
      expect((await as(owner, 'GET', '/users')).statusCode).toBe(200);
    } finally {
      await sql`update auth_sessions set created_at = now() where user_id = ${owner.userId}`;
    }
  });

  it('only an owner manages people', async () => {
    const listener = await createTestUser(handle, { role: 'listener' });
    const editor = await createTestUser(handle, { role: 'editor' });
    for (const u of [listener, editor]) {
      expect((await as(u, 'GET', '/users')).statusCode).toBe(403);
      expect((await as(u, 'POST', '/users/invites', { email: 'x@example.com', role: 'owner' })).statusCode).toBe(403);
      expect((await as(u, 'PATCH', `/users/${u.userId}`, { role: 'owner' })).statusCode).toBe(403);
    }
    expect((await as(undefined, 'GET', '/users')).statusCode).toBe(401);
  });

  it('lists people with their role, status, last sign-in and second factors', async () => {
    const res = await as(owner, 'GET', '/users');
    const body = res.json() as UsersOverview;
    const me = body.users.find((u) => u.id === owner.userId)!;
    expect(me).toMatchObject({ name: 'Ada Owner', role: 'owner', status: 'active', isSelf: true, twoFactor: false, passkeys: 0 });
    expect(me.lastSeenAt).not.toBeNull();
    expect(body.users.some((u) => u.email === 'deniz@example.com' && u.role === 'listener')).toBe(true);
  });

  it('changes a role, and never leaves the install without an owner', async () => {
    const person = await createTestUser(handle, { role: 'listener' });
    expect((await as(owner, 'PATCH', `/users/${person.userId}`, { role: 'editor' })).statusCode).toBe(204);
    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: headers(person.cookie) });
    expect(me.json().user.role).toBe('editor');

    // the only owner cannot step down or turn themselves off
    const owners = await sql<{ n: number }[]>`select count(*)::int as n from users where role = 'owner' and disabled_at is null and removed_at is null`;
    expect(owners[0]!.n).toBe(1);
    expect((await as(owner, 'PATCH', `/users/${owner.userId}`, { role: 'editor' })).statusCode).toBe(409);
    expect((await as(owner, 'PATCH', `/users/${owner.userId}`, { disabled: true })).statusCode).toBe(409);
    expect((await as(owner, 'DELETE', `/users/${owner.userId}`, { data: 'keep' })).statusCode).toBe(409);

    // with a second owner, the first may step down — and the second cannot then leave
    const second = await createTestUser(handle, { role: 'owner' });
    expect((await as(owner, 'PATCH', `/users/${owner.userId}`, { role: 'editor' })).statusCode).toBe(204);
    expect((await as(second, 'PATCH', `/users/${second.userId}`, { role: 'listener' })).statusCode).toBe(409);
    expect((await as(second, 'PATCH', `/users/${owner.userId}`, { role: 'owner' })).statusCode).toBe(204);
    expect((await as(owner, 'DELETE', `/users/${second.userId}`, { data: 'delete' })).statusCode).toBe(204);
  });

  it('turning an account off signs it out everywhere and refuses sign-in until it is back on', async () => {
    const person = await createTestUser(handle, { role: 'editor' });
    expect((await as(owner, 'PATCH', `/users/${person.userId}`, { disabled: true })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: headers(person.cookie) })).statusCode).toBe(401);
    const refused = await signIn(person.email, person.password);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().code).toBe('ACCOUNT_INACTIVE');
    // no set-password link for an account that is off
    expect((await as(owner, 'POST', `/users/${person.userId}/reset-sign-in`, {})).statusCode).toBe(409);

    expect((await as(owner, 'PATCH', `/users/${person.userId}`, { disabled: false })).statusCode).toBe(204);
    expect((await signIn(person.email, person.password)).statusCode).toBe(200);
  });

  it('a set-password link replaces the password, ends every session and can clear second factors', async () => {
    const person = await createTestUser(handle, { role: 'listener' });
    await sql`update users set two_factor_enabled = true where id = ${person.userId}`;
    await sql`insert into auth_two_factors (user_id, secret, backup_codes) values (${person.userId}, 'x', 'y')`;
    const res = await as(owner, 'POST', `/users/${person.userId}/reset-sign-in`, { clearSecondFactors: true });
    expect(res.statusCode).toBe(201);
    const { link, invite } = res.json() as InviteLinkResponse;
    expect(invite).toMatchObject({ purpose: 'reset', userId: person.userId });
    const token = link.split('/invite/')[1]!;
    expect((await app.inject({ method: 'GET', url: `/api/v1/invites/${token}` })).json()).toMatchObject({ purpose: 'reset', clearSecondFactors: true });

    const used = await accept(token, { password: NEW_PASSWORD });
    expect(used.statusCode, used.body).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: headers(person.cookie) })).statusCode).toBe(401);
    expect((await signIn(person.email, person.password)).statusCode).toBe(401);
    expect((await signIn(person.email, NEW_PASSWORD)).statusCode).toBe(200);
    expect(await sql`select 1 from auth_two_factors where user_id = ${person.userId}`).toHaveLength(0);
    expect((await accept(token, { password: NEW_PASSWORD })).statusCode).toBe(404);
  });

  it('removing someone keeps or deletes their data, as the owner chose, and hands over what they created', async () => {
    const keep = await createTestUser(handle, { role: 'editor', email: 'keep@example.com' });
    const gone = await createTestUser(handle, { role: 'listener', email: 'gone@example.com' });
    const rg = (await sql<{ id: string }[]>`insert into release_groups (mbid, title) values (${randomUUID()}, 'An album') returning id`)[0]!.id;
    for (const u of [keep, gone]) {
      await sql`insert into listens (library_id, user_id, release_group_id, listened_at) values (${libraryId}, ${u.userId}, ${rg}, now())`;
    }
    const theirLibrary = (await sql<{ id: string }[]>`
      insert into libraries (owner_user_id, name, settings) values (${keep.userId}, 'Made by keep', '{}') returning id`)[0]!.id;

    expect((await as(owner, 'DELETE', `/users/${keep.userId}`, { data: 'keep' })).statusCode).toBe(204);
    const [row] = await sql`select email, removed_at, disabled_at from users where id = ${keep.userId}`;
    expect(row!['removed_at']).not.toBeNull();
    expect(row!['email']).not.toBe('keep@example.com');
    expect(await sql`select 1 from listens where user_id = ${keep.userId}`).toHaveLength(1);
    expect(await sql`select 1 from auth_sessions where user_id = ${keep.userId}`).toHaveLength(0);
    expect(await sql`select 1 from auth_accounts where user_id = ${keep.userId}`).toHaveLength(0);
    const [lib] = await sql`select owner_user_id from libraries where id = ${theirLibrary}`;
    expect(lib!['owner_user_id']).toBe(owner.userId);
    // the address can be invited again
    await invite('keep@example.com', 'listener');

    expect((await as(owner, 'DELETE', `/users/${gone.userId}`, { data: 'delete' })).statusCode).toBe(204);
    expect(await sql`select 1 from users where id = ${gone.userId}`).toHaveLength(0);
    expect(await sql`select 1 from listens where user_id = ${gone.userId}`).toHaveLength(0);

    // a kept account's data can still be deleted later
    expect((await as(owner, 'DELETE', `/users/${keep.userId}`, { data: 'delete' })).statusCode).toBe(204);
    expect(await sql`select 1 from listens where user_id = ${keep.userId}`).toHaveLength(0);
  });

  it('everyone reads the shared library; saved views and listens stay with their person', async () => {
    const listener = await createTestUser(handle, { role: 'listener' });
    const libs = await as(listener, 'GET', '/libraries');
    expect(libs.statusCode).toBe(200);
    expect(libs.json().data.map((l: { id: string }) => l.id)).toContain(libraryId);
    expect((await as(listener, 'GET', `/libraries/${libraryId}/albums`)).statusCode).toBe(200);

    const mine = await as(owner, 'POST', `/libraries/${libraryId}/saved-views`, { name: 'Owner view', query: {} });
    expect(mine.statusCode, mine.body).toBe(201);
    const theirs = await as(listener, 'POST', `/libraries/${libraryId}/saved-views`, { name: 'Listener view', query: {} });
    expect(theirs.statusCode).toBe(201);
    const names = async (u: TestUser) => (await as(u, 'GET', `/libraries/${libraryId}/saved-views`)).json().items.map((v: { name: string }) => v.name);
    expect(await names(owner)).toEqual(['Owner view']);
    expect(await names(listener)).toEqual(['Listener view']);
    expect((await as(listener, 'DELETE', `/saved-views/${mine.json().id}`)).statusCode).toBe(404);

    const rg = (await sql<{ id: string }[]>`insert into release_groups (mbid, title) values (${randomUUID()}, 'Another') returning id`)[0]!.id;
    const listen = (await sql<{ id: string }[]>`
      insert into listens (library_id, user_id, release_group_id, listened_at) values (${libraryId}, ${owner.userId}, ${rg}, now()) returning id`)[0]!.id;
    expect((await as(listener, 'DELETE', `/listens/${listen}`)).statusCode).toBe(404);
    expect(await sql`select 1 from listens where id = ${listen}`).toHaveLength(1);

    // the provider keys stay with the owner
    await sql`update libraries set settings = ${sql.json({ contactString: 'ada@example.com', discogsTokenHint: 'abcd' })} where id = ${libraryId}`;
    const s = (await as(listener, 'GET', `/libraries/${libraryId}/settings`)).json();
    expect(s).toMatchObject({ contactString: null, discogsTokenHint: null, discogsTokenSet: true });
    expect((await as(owner, 'GET', `/libraries/${libraryId}/settings`)).json()).toMatchObject({ contactString: 'ada@example.com', discogsTokenHint: 'abcd' });
    const editor = await createTestUser(handle, { role: 'editor' });
    expect((await as(editor, 'PATCH', `/libraries/${libraryId}/settings`, { contactString: 'evil@example.com' })).statusCode).toBe(403);
    // the setup checklist on Home is the owner's to dismiss, for good
    const dismissedAt = '2026-10-20T10:00:00.000Z';
    expect((await as(editor, 'PATCH', `/libraries/${libraryId}/settings`, { setupChecklistDismissedAt: dismissedAt })).statusCode).toBe(403);
    expect((await as(owner, 'GET', `/libraries/${libraryId}/settings`)).json()).toMatchObject({ setupChecklistDismissedAt: null });
    expect((await as(owner, 'PATCH', `/libraries/${libraryId}/settings`, { setupChecklistDismissedAt: dismissedAt })).json()).toMatchObject({ setupChecklistDismissedAt: dismissedAt });
    expect((await as(owner, 'GET', `/libraries/${libraryId}/settings`)).json()).toMatchObject({ setupChecklistDismissedAt: dismissedAt, contactString: 'ada@example.com' });

    // the library list carries no install settings for a listener or an editor, and no sealed secrets for anyone
    await sql`update libraries set settings = ${sql.json({ contactString: 'ada@example.com', discogsToken: 'enc:v1:t', discogsTokenHint: 'abcd', playerUrl: 'http://nd', playerUser: 'admin', playerPassword: 'enc:v1:p', lastfmApiKey: 'enc:v1:k', lastfmSecret: 'enc:v1:s', lastfmApiKeyHint: 'wxyz' })} where id = ${libraryId}`;
    const listed = async (u: TestUser) => (await as(u, 'GET', '/libraries')).json().data.find((l: { id: string }) => l.id === libraryId).settings;
    expect(await listed(listener)).toEqual({});
    expect(await listed(editor)).toEqual({});
    const ownerList = await listed(owner);
    expect(ownerList).toMatchObject({ contactString: 'ada@example.com', discogsTokenHint: 'abcd', lastfmApiKeyHint: 'wxyz' });
    for (const k of ['discogsToken', 'playerPassword', 'lastfmApiKey', 'lastfmSecret']) expect(ownerList).not.toHaveProperty(k);

    // the library's numbers count the caller's own reviews and listens, not everyone's
    await sql`insert into user_reviews (user_id, library_id, release_group_id, rating, body_md) values (${owner.userId}, ${libraryId}, ${rg}, 4, 'Mine')`;
    const stats = async (u: TestUser) => (await as(u, 'GET', `/libraries/${libraryId}/stats`)).json().reviews;
    expect(await stats(owner)).toMatchObject({ written: 1, rated: 1, listens: 1 });
    expect(await stats(listener)).toMatchObject({ written: 0, rated: 0, listens: 0 });
  });

  it('links an owner made stop working when they stop being an owner', async () => {
    const co = await createTestUser(handle, { role: 'owner' });
    const made = async (email: string) => {
      const res = await as(co, 'POST', '/users/invites', { email, role: 'owner' });
      expect(res.statusCode, res.body).toBe(201);
      return (res.json() as InviteLinkResponse).link.split('/invite/')[1]!;
    };
    const open = async (token: string) => (await app.inject({ method: 'GET', url: `/api/v1/invites/${token}` })).statusCode;
    const a = await made('alt-a@example.com');
    expect(await open(a)).toBe(200);
    expect((await as(owner, 'PATCH', `/users/${co.userId}`, { role: 'editor' })).statusCode).toBe(204);
    expect(await open(a)).toBe(404);
    expect((await accept(a)).statusCode).toBe(404);

    expect((await as(owner, 'PATCH', `/users/${co.userId}`, { role: 'owner' })).statusCode).toBe(204);
    const b = await made('alt-b@example.com');
    expect((await as(owner, 'DELETE', `/users/${co.userId}`, { data: 'delete' })).statusCode).toBe(204);
    expect(await open(b)).toBe(404);
  });

  it('serves only the Better Auth endpoints tagave uses', async () => {
    for (const path of ['/sign-up/email', '/delete-user', '/change-email', '/request-password-reset', '/link-social', '/update-session']) {
      const res = await app.inject({ method: 'POST', url: `/api/auth${path}`, headers: { ...headers(owner.cookie), 'content-type': 'application/json' }, payload: {} });
      expect(res.statusCode, path).toBe(404);
    }
    const session = await app.inject({ method: 'GET', url: '/api/auth/get-session', headers: headers(owner.cookie) });
    expect(session.statusCode).toBe(200);
    // update-user cannot change a role
    const listener = await createTestUser(handle, { role: 'listener' });
    await app.inject({ method: 'POST', url: '/api/auth/update-user', headers: { ...headers(listener.cookie), 'content-type': 'application/json' }, payload: { name: 'New name', role: 'owner' } });
    const [row] = await sql`select role from users where id = ${listener.userId}`;
    expect(row!['role']).toBe('listener');
  });
});
