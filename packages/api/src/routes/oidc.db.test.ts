/**
 * Sign in with your login service, end to end against a scratch database and
 * a small OpenID Connect provider (testkit/fakeOidc.ts): Settings › Users
 * saves it and the auth instance is rebuilt; who may sign in, join, link and
 * unlink; invites; step-up at the service; and the checks that keep the flow
 * honest (state, nonce, PKCE, issuer, one answer for every failure).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import postgres from 'postgres';
import type { AuthHandle } from '@tagave/auth';
import type { InviteLinkResponse, OidcSettingsResponse, StepUpStatus } from '@tagave/shared';
import { registerApiRoutes } from '../app.js';
import { initAuth } from '../middleware/auth.js';
import { TEST_PUBLIC_URL, cookieHeader, cookieJar, createScratchDb, migrateAll, testAuth } from '../testkit/authApp.js';
import { createTestUser, type TestUser } from '../testkit/users.js';
import { FakeOidc, type AuthorizeOptions, type FakeUser } from '../testkit/fakeOidc.js';
import { resetUserRouteLimits } from './users.js';
import { resetInviteRouteLimits } from './invites.js';
import { resetOidcRouteLimits } from './oidc.js';
import { resetAccountSignInLimits } from './betterAuth.js';
import { resetStepUpFailures } from './stepUp.js';

const adminUrl = process.env.TEST_DATABASE_URL;
const SESSION = 'tagave.session_token';
type Jar = Record<string, string>;

describe.skipIf(!adminUrl)('sign in with your login service (integration)', () => {
  let admin: postgres.Sql;
  let db: { url: string; name: string };
  let handle: AuthHandle;
  let sql: postgres.Sql;
  let app: FastifyInstance;
  let owner: TestUser;
  const idp = new FakeOidc();

  const headers = (jar: Jar = {}) => ({ origin: TEST_PUBLIC_URL, cookie: cookieHeader(jar) });
  const call = (jar: Jar | undefined, method: string, url: string, payload?: unknown) =>
    app.inject({ method: method as never, url, headers: headers(jar), ...(payload !== undefined ? { payload: payload as object } : {}) });
  const ageSessions = (userId: string) => sql`update auth_sessions set created_at = now() - interval '10 minutes' where user_id = ${userId}`;

  async function configure(over: Record<string, unknown> = {}) {
    const res = await call(owner.jar, 'PUT', '/api/v1/users/sign-in-service', {
      name: 'Testauth',
      issuer: idp.issuer,
      clientId: idp.clientId,
      clientSecret: idp.clientSecret,
      enabled: true,
      joinEnabled: false,
      joinGroup: null,
      ...over,
    });
    return res;
  }

  /** Start a flow, sign `user` in at the service, follow the callback. Returns where tagave sent the browser and the jar. */
  async function flow(
    start: { url: string; jar?: Jar; payload?: unknown },
    user: FakeUser,
    opts: AuthorizeOptions & { tamperState?: boolean; dropStateCookie?: boolean } = {},
  ) {
    let jar: Jar = { ...(start.jar ?? {}) };
    const res = await call(jar, 'POST', start.url, start.payload ?? {});
    expect(res.statusCode, res.body).toBe(200);
    jar = cookieJar(res.headers['set-cookie'], jar);
    const authUrl = (res.json() as { url: string }).url;
    let back = new URL(idp.authorize(authUrl, user, opts));
    if (opts.tamperState) back.searchParams.set('state', 'x'.repeat(32));
    const cbJar = { ...jar };
    if (opts.dropStateCookie) for (const k of Object.keys(cbJar)) if (k.includes('state')) delete cbJar[k];
    const cb = await app.inject({ method: 'GET', url: `${back.pathname}${back.search}`, headers: { cookie: cookieHeader(cbJar) } });
    expect([302, 303, 307]).toContain(cb.statusCode);
    jar = cookieJar(cb.headers['set-cookie'], jar);
    back = new URL(String(cb.headers.location));
    return { location: back, jar, authUrl: new URL(authUrl), cbSetCookie: cb.headers['set-cookie'] };
  }

  const signIn = (user: FakeUser, opts?: AuthorizeOptions & { tamperState?: boolean; dropStateCookie?: boolean }) =>
    flow({ url: '/api/v1/auth/oidc/sign-in' }, user, opts);

  const sessionCookieSet = (setCookie: string | string[] | undefined) =>
    (Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : []).some((c) => c.startsWith(`${SESSION}=`) && !/max-age=0/i.test(c));

  async function me(jar: Jar) {
    const res = await call(jar, 'GET', '/api/v1/auth/me');
    return res.statusCode === 200 ? (res.json() as { user: { id: string; email: string; role: string } }).user : null;
  }

  beforeAll(async () => {
    await idp.start();
    admin = postgres(adminUrl!, { max: 1, onnotice: () => undefined });
    db = await createScratchDb(adminUrl!, admin);
    await migrateAll(db.url);
    handle = testAuth(db.url);
    sql = handle.sql;
    initAuth(handle);
    const { initDb } = await import('../db.js');
    await initDb(db.url);
    owner = await createTestUser(handle, { role: 'owner', name: 'Ada Owner', email: 'ada@example.test' });
    await sql`insert into libraries (owner_user_id, name, settings) values (${owner.userId}, 'Shared', '{}')`;
    app = Fastify({ logger: false });
    await app.register(fastifyCookie);
    await registerApiRoutes(app, { backupService: { dir: '/nonexistent' } as never });
    await app.ready();
  }, 60_000);

  beforeEach(() => {
    resetUserRouteLimits();
    resetInviteRouteLimits();
    resetOidcRouteLimits();
    resetAccountSignInLimits();
    resetStepUpFailures();
  });

  afterAll(async () => {
    await app?.close();
    const { getSql } = await import('../db.js');
    await getSql().end({ timeout: 2 }).catch(() => undefined);
    await handle?.close();
    if (db) await admin.unsafe(`drop database if exists ${db.name} with (force)`).catch(() => undefined);
    await admin?.end({ timeout: 2 });
    await idp.stop();
  });

  it('no button until it is set up', async () => {
    const res = await call(undefined, 'GET', '/api/v1/auth/oidc');
    expect(res.json()).toEqual({ name: null });
    const start = await call(undefined, 'POST', '/api/v1/auth/oidc/sign-in', {});
    expect(start.statusCode).toBe(404);
  });

  it('Test checks discovery; a document naming another issuer is refused', async () => {
    const ok = await call(owner.jar, 'POST', '/api/v1/users/sign-in-service/test', { issuer: `${idp.issuer}/` });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ issuer: idp.issuer, pkceS256: true });

    idp.discoveryIssuer = 'https://evil.example';
    const bad = await call(owner.jar, 'POST', '/api/v1/users/sign-in-service/test', { issuer: idp.issuer });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().detail).toMatch(/another issuer/);
    const save = await configure();
    expect(save.statusCode).toBe(400);
    idp.discoveryIssuer = null;

    const plain = await call(owner.jar, 'POST', '/api/v1/users/sign-in-service/test', { issuer: 'http://login.example.net' });
    expect(plain.statusCode).toBe(400);
    expect(plain.json().detail).toMatch(/https/);
  });

  it('only the owner manages it, saving needs a fresh sign-in, and the secret never comes back', async () => {
    const listener = await createTestUser(handle, { role: 'listener' });
    expect((await call(listener.jar, 'GET', '/api/v1/users/sign-in-service')).statusCode).toBe(403);
    expect((await call(listener.jar, 'PUT', '/api/v1/users/sign-in-service', {})).statusCode).toBe(403);

    await ageSessions(owner.userId);
    const stale = await configure();
    expect(stale.statusCode).toBe(403);
    expect(stale.json().title).toBe('Step-up required');
    await sql`update auth_sessions set created_at = now() where user_id = ${owner.userId}`;

    const res = await configure();
    expect(res.statusCode, res.body).toBe(200);
    const view = res.json() as OidcSettingsResponse;
    expect(view.active).toBe(true);
    expect(view.redirectUri).toBe(`${TEST_PUBLIC_URL}/api/auth/callback/oidc`);
    expect(view.settings).toMatchObject({ name: 'Testauth', issuer: idp.issuer, clientId: idp.clientId, secretSet: true });
    expect(res.body).not.toContain(idp.clientSecret);
    const got = await call(owner.jar, 'GET', '/api/v1/users/sign-in-service');
    expect(got.body).not.toContain(idp.clientSecret);
    const [row] = await sql<Array<{ client_secret: string }>>`select client_secret from auth_oidc_config`;
    expect(row!.client_secret).not.toContain(idp.clientSecret);

    // saved without a secret: the stored one stays
    expect((await configure({ clientSecret: undefined })).json().settings.secretSet).toBe(true);
    expect((await call(undefined, 'GET', '/api/v1/auth/oidc')).json()).toEqual({ name: 'Testauth' });
  });

  it('the authorization request carries state, a nonce and PKCE S256', async () => {
    const res = await call(undefined, 'POST', '/api/v1/auth/oidc/sign-in', {});
    const q = new URL(res.json().url).searchParams;
    expect(q.get('state')).toBeTruthy();
    expect(q.get('nonce')).toBeTruthy();
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(q.get('redirect_uri')).toBe(`${TEST_PUBLIC_URL}/api/auth/callback/oidc`);
    expect(q.get('scope')?.split(' ')).toEqual(expect.arrayContaining(['openid', 'email', 'profile']));
  });

  it('an unlinked identity cannot sign in while join is off', async () => {
    const before = (await sql`select count(*)::int as n from users`)[0]!.n;
    const out = await signIn({ sub: 'stranger-1', email: 'stranger@example.test', name: 'Stranger' });
    expect(out.location.pathname).toBe('/login');
    expect(out.location.search).toBe('?oidc=failed');
    expect(sessionCookieSet(out.cbSetCookie)).toBe(false);
    expect((await sql`select count(*)::int as n from users`)[0]!.n).toBe(before);
  });

  it('no takeover through a matching email, and the failure looks like any other', async () => {
    await configure({ joinEnabled: true });
    const stranger = await signIn({ sub: 'stranger-2', email: 'nobody@example.test', name: 'X' }, { claims: { groups: [] } });
    // the service vouches for the owner's address: still not the owner
    const impostor = await signIn({ sub: 'attacker-1', email: 'ADA@example.test', name: 'Ada', emailVerified: true });
    expect(impostor.location.toString()).toBe(`${TEST_PUBLIC_URL}/login?oidc=failed`);
    expect(sessionCookieSet(impostor.cbSetCookie)).toBe(false);
    const links = await sql`select 1 from auth_accounts where user_id = ${owner.userId} and provider_id = 'oidc'`;
    expect(links).toHaveLength(0);
    // and it joined nobody
    expect(await sql`select 1 from auth_accounts where account_id = 'attacker-1'`).toHaveLength(0);
    // "would make a new account" (join on, here: allowed) differs; a refusal never says why
    expect(stranger.location.pathname).toBe('/');
    await configure({ joinEnabled: false });
  });

  it('join limited to a group refuses someone outside it and makes a listener for someone in it', async () => {
    await configure({ joinEnabled: true, joinGroup: 'music' });
    const authUrl = new URL((await call(undefined, 'POST', '/api/v1/auth/oidc/sign-in', {})).json().url);
    expect(authUrl.searchParams.get('scope')?.split(' ')).toContain('groups');

    const outside = await signIn({ sub: 'out-1', email: 'out@example.test', name: 'Out', groups: ['family'] });
    expect(outside.location.toString()).toBe(`${TEST_PUBLIC_URL}/login?oidc=failed`);
    expect(await sql`select 1 from users where email = 'out@example.test'`).toHaveLength(0);

    const inside = await signIn({ sub: 'in-1', email: 'in@example.test', name: 'Inés', groups: ['family', 'music'] });
    expect(inside.location.toString()).toBe(`${TEST_PUBLIC_URL}/`);
    const who = await me(inside.jar);
    expect(who).toMatchObject({ email: 'in@example.test', role: 'listener' });
    const [acct] = await sql<Array<{ access_token: string | null; refresh_token: string | null; id_token: string | null }>>`
      select access_token, refresh_token, id_token from auth_accounts where provider_id = 'oidc' and account_id = 'in-1'`;
    expect(acct).toEqual({ access_token: null, refresh_token: null, id_token: null });

    // a profile claim never sets the role
    const roleClaim = await signIn({ sub: 'in-2', email: 'in2@example.test', name: 'Two', groups: ['music'] }, { claims: { role: 'owner' } });
    expect((await me(roleClaim.jar))?.role).toBe('listener');
    await configure({ joinEnabled: false, joinGroup: null });
  });

  it('a bad state, a missing state cookie, a wrong nonce or another issuer in the id_token all fail the same way', async () => {
    const user = { sub: 'in-1', email: 'in@example.test', name: 'Inés' };
    expect((await signIn(user)).location.pathname).toBe('/');
    for (const opts of [{ tamperState: true }, { dropStateCookie: true }, { claims: { nonce: 'not-the-nonce' } }, { claims: { iss: 'https://evil.example' } }, { claims: { aud: 'someone-else' } }]) {
      const out = await signIn(user, opts);
      expect(out.location.search, JSON.stringify(opts)).toBe('?oidc=failed');
      expect(sessionCookieSet(out.cbSetCookie)).toBe(false);
    }
    expect(idp.pkceFailures).toBe(0);
  });

  it('a signed-in person links explicitly (after a fresh sign-in), signs in with it, and unlinks', async () => {
    // linking adds a way in: a stale session confirms first
    await ageSessions(owner.userId);
    const stale = await call(owner.jar, 'POST', '/api/v1/auth/oidc/link', {});
    expect(stale.statusCode).toBe(403);
    await sql`update auth_sessions set created_at = now() where user_id = ${owner.userId}`;

    const linked = await flow({ url: '/api/v1/auth/oidc/link', jar: owner.jar }, { sub: 'ada-idp', email: 'ada.lovelace@idp.example', name: 'Ada L' });
    expect(linked.location.toString()).toBe(`${TEST_PUBLIC_URL}/settings/account?oidc=linked`);
    const view = await call(owner.jar, 'GET', '/api/v1/auth/oidc/link');
    expect(view.json()).toMatchObject({ name: 'Testauth', linked: true, canUnlink: true });
    // the link names another address than the account's; the account keeps its own
    expect((await sql`select email from users where id = ${owner.userId}`)[0]!.email).toBe('ada@example.test');

    const again = await call(owner.jar, 'POST', '/api/v1/auth/oidc/link', {});
    expect(again.statusCode).toBe(409);

    const viaIdp = await signIn({ sub: 'ada-idp', email: 'ada.lovelace@idp.example', name: 'Ada L' });
    expect(viaIdp.location.toString()).toBe(`${TEST_PUBLIC_URL}/`);
    expect((await me(viaIdp.jar))?.id).toBe(owner.userId);

    // another identity already linked to someone else cannot be linked here
    const taken = await flow({ url: '/api/v1/auth/oidc/link', jar: (await createTestUser(handle, { role: 'listener' })).jar }, { sub: 'ada-idp', email: 'x@example.test' });
    expect(taken.location.search).toBe('?oidc=failed');

    const unlink = await call(owner.jar, 'DELETE', '/api/v1/auth/oidc/link');
    expect(unlink.statusCode).toBe(204);
    expect((await signIn({ sub: 'ada-idp', email: 'ada.lovelace@idp.example' })).location.search).toBe('?oidc=failed');
  });

  it('unlinking the last way in is refused', async () => {
    const [m] = await sql<Array<{ id: string }>>`select u.id from users u join auth_accounts a on a.user_id = u.id where a.account_id = 'in-1'`;
    const s = await signIn({ sub: 'in-1', email: 'in@example.test' });
    expect((await me(s.jar))?.id).toBe(m!.id);
    const view = await call(s.jar, 'GET', '/api/v1/auth/oidc/link');
    expect(view.json()).toMatchObject({ linked: true, canUnlink: false });
    const res = await call(s.jar, 'DELETE', '/api/v1/auth/oidc/link');
    expect(res.statusCode).toBe(409);
    expect(await sql`select 1 from auth_accounts where account_id = 'in-1'`).toHaveLength(1);
  });

  it('the owner cannot become login-service-only', async () => {
    const [m] = await sql<Array<{ id: string }>>`select user_id as id from auth_accounts where account_id = 'in-1'`;
    const promote = await call(owner.jar, 'PATCH', `/api/v1/users/${m!.id}`, { role: 'owner' });
    expect(promote.statusCode).toBe(409);
    expect((await sql`select role from users where id = ${m!.id}`)[0]!.role).toBe('listener');

    // an owner invite is accepted with a password, never through the service
    const inv = await call(owner.jar, 'POST', '/api/v1/users/invites', { email: 'co-owner@example.test', role: 'owner' });
    const token = (inv.json() as InviteLinkResponse).link.split('/invite/')[1]!;
    const start = await call(undefined, 'POST', '/api/v1/auth/oidc/sign-in', { invite: token });
    expect(start.statusCode).toBe(404);
  });

  it('the last passkey of an account without a password goes only when the login service is left, and never for an owner', async () => {
    const addPasskey = (userId: string) => sql<Array<{ id: string }>>`
      insert into auth_passkeys (user_id, public_key, credential_id, counter, device_type, backed_up)
      values (${userId}, 'pk', ${`cred-${userId}`}, 0, 'singleDevice', false) returning id`;
    const deletePasskey = (jar: Jar, id: string) => app.inject({
      method: 'POST', url: '/api/auth/passkey/delete-passkey',
      headers: { ...headers(jar), 'content-type': 'application/json' }, payload: { id },
    });
    for (const role of ['listener', 'owner'] as const) {
      const u = await createTestUser(handle, { role });
      await sql`delete from auth_accounts where user_id = ${u.userId} and provider_id = 'credential'`;
      const [pk] = await addPasskey(u.userId);
      const alone = await deletePasskey(u.jar, pk!.id);
      expect(alone.statusCode, alone.body).toBe(400);
      expect(alone.json().code).toBe('LAST_WAY_IN');
      await sql`insert into auth_accounts (user_id, account_id, provider_id) values (${u.userId}, ${`idp-${role}`}, 'oidc')`;
      const withService = await deletePasskey(u.jar, pk!.id);
      expect(withService.statusCode, withService.body).toBe(role === 'owner' ? 400 : 200);
    }
  });

  it('an invite accepted through the service makes the invited account with its role, once', async () => {
    const inv = await call(owner.jar, 'POST', '/api/v1/users/invites', { email: 'Ed@Example.test', role: 'editor' });
    expect(inv.statusCode, inv.body).toBe(201);
    const token = (inv.json() as InviteLinkResponse).link.split('/invite/')[1]!;
    // join is off: the invite is what lets them in
    const out = await flow({ url: '/api/v1/auth/oidc/sign-in', payload: { invite: token } }, { sub: 'ed-1', email: 'ed.personal@idp.example', name: 'Ed' });
    expect(out.location.toString()).toBe(`${TEST_PUBLIC_URL}/`);
    expect(await me(out.jar)).toMatchObject({ email: 'ed@example.test', role: 'editor' });
    expect((await sql`select used_at from user_invites where email = 'ed@example.test'`)[0]!.used_at).not.toBeNull();
    // the stored state names the invite by its hash only
    expect(await sql`select 1 from auth_verifications where value like ${`%${token}%`}`).toHaveLength(0);
    const reuse = await call(undefined, 'POST', '/api/v1/auth/oidc/sign-in', { invite: token });
    expect(reuse.statusCode).toBe(404);
  });

  it('a login-service-only member re-verifies at the service, and only a fresh auth_time counts', async () => {
    const s = await signIn({ sub: 'in-1', email: 'in@example.test' });
    const userId = (await me(s.jar))!.id;
    await ageSessions(userId);
    const status = (await call(s.jar, 'GET', '/api/v1/auth/step-up')).json() as StepUpStatus;
    expect(status.fresh).toBe(false);
    expect(status.methods).toEqual(['oidc']);
    expect(status.oidcName).toBe('Testauth');

    const old = await flow({ url: '/api/v1/auth/step-up/oidc', jar: s.jar }, { sub: 'in-1', email: 'in@example.test' }, { authTime: Math.floor(Date.now() / 1000) - 3600 });
    expect(old.location.toString()).toBe(`${TEST_PUBLIC_URL}/auth/oidc-done?oidc=failed`);
    expect(old.authUrl.searchParams.get('prompt')).toBe('login');
    expect(old.authUrl.searchParams.get('max_age')).toBe('0');
    expect(((await call(s.jar, 'GET', '/api/v1/auth/step-up')).json() as StepUpStatus).fresh).toBe(false);

    // someone else at the service cannot confirm for this account
    const other = await flow({ url: '/api/v1/auth/step-up/oidc', jar: s.jar }, { sub: 'in-2', email: 'in2@example.test' });
    expect(other.location.search).toBe('?oidc=failed');
    expect(((await call(s.jar, 'GET', '/api/v1/auth/step-up')).json() as StepUpStatus).fresh).toBe(false);
    expect(await sql`select 1 from auth_accounts where user_id = ${userId} and account_id = 'in-2'`).toHaveLength(0);

    const ok = await flow({ url: '/api/v1/auth/step-up/oidc', jar: s.jar }, { sub: 'in-1', email: 'in@example.test' });
    expect(ok.location.toString()).toBe(`${TEST_PUBLIC_URL}/auth/oidc-done`);
    const after = (await call(s.jar, 'GET', '/api/v1/auth/step-up')).json() as StepUpStatus;
    expect(after.fresh).toBe(true);
    expect((await sql`select method from auth_step_ups where user_id = ${userId}`)[0]!.method).toBe('oidc');
  });

  it('a turned-off account gets no session through the service', async () => {
    const [m] = await sql<Array<{ id: string }>>`select user_id as id from auth_accounts where account_id = 'in-2'`;
    expect((await call(owner.jar, 'PATCH', `/api/v1/users/${m!.id}`, { disabled: true })).statusCode).toBe(204);
    const out = await signIn({ sub: 'in-2', email: 'in2@example.test' });
    expect(out.location.search).toBe('?oidc=failed');
    expect(sessionCookieSet(out.cbSetCookie)).toBe(false);
  });

  it('changing the issuer unlinks everyone, after saying so; turning it off hides the button', async () => {
    const other = new FakeOidc();
    await other.start();
    try {
      const res = await call(owner.jar, 'PUT', '/api/v1/users/sign-in-service', {
        name: 'Other', issuer: other.issuer, clientId: other.clientId, clientSecret: other.clientSecret, enabled: true, joinEnabled: false, joinGroup: null,
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().detail).toMatch(/linked to the old issuer/);
      const ok = await call(owner.jar, 'PUT', '/api/v1/users/sign-in-service', {
        name: 'Other', issuer: other.issuer, clientId: other.clientId, clientSecret: other.clientSecret, enabled: true, joinEnabled: false, joinGroup: null, unlinkAll: true,
      });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(await sql`select 1 from auth_accounts where provider_id = 'oidc'`).toHaveLength(0);
    } finally {
      await other.stop();
    }
    const off = await configure({ enabled: false, clientSecret: idp.clientSecret, unlinkAll: true });
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json().active).toBe(false);
    expect((await call(undefined, 'GET', '/api/v1/auth/oidc')).json()).toEqual({ name: null });
    expect((await call(undefined, 'POST', '/api/v1/auth/oidc/sign-in', {})).statusCode).toBe(404);
  });
});
