/**
 * Music Connections linking against the real server (registerApiRoutes, the
 * route guard, Better Auth sessions) on a scratch database: register →
 * authorize → consent → token → refresh → revoke, and the refusals the spec
 * names (§2, §5 Security, §6 Auth).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import postgres from 'postgres';
import { ManifestSchema } from 'music-connections';
import type { AuthHandle } from '@tagave/auth';
import { registerApiRoutes } from '../app.js';
import { initAuth } from '../middleware/auth.js';
import { TEST_PUBLIC_URL, createScratchDb, migrateAll, testAuth } from '../testkit/authApp.js';
import { createTestUser, type TestUser } from '../testkit/users.js';
import { turnMcOn } from '../testkit/mc.js';
import { mcEnabled, setMcEnabled } from '@tagave/db';
import { hashToken, knownGoodTokens, lookupAccessToken, pkceChallenge } from '../lib/mcOAuth.js';
import { connectConfig, resetConnectRouteLimits } from './connect.js';

const adminUrl = process.env.TEST_DATABASE_URL;
const REDIRECT = 'http://192.168.77.50:8080/connect/callback';
const SCOPE = 'ratings:read collection:read listens:read identity:read offline_access';
const VERIFIER = 'v'.repeat(20) + '-the-pkce-verifier-of-this-test-0123456789';

const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

describe.skipIf(!adminUrl)('music connections OAuth provider (integration)', () => {
  let admin: postgres.Sql;
  let db: { url: string; name: string };
  let handle: AuthHandle;
  let app: FastifyInstance;
  let person: TestUser;

  beforeAll(async () => {
    admin = postgres(adminUrl!, { max: 1, onnotice: () => undefined });
    db = await createScratchDb(adminUrl!, admin);
    await migrateAll(db.url);
    handle = testAuth(db.url);
    initAuth(handle);
    person = await createTestUser(handle, { role: 'listener' });
    await turnMcOn(handle.sql, person.userId);
    app = Fastify({ logger: false });
    await app.register(fastifyCookie);
    await registerApiRoutes(app, { backupService: { dir: '/nonexistent' } as never });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await handle?.close();
    if (db) await admin.unsafe(`drop database if exists ${db.name} with (force)`).catch(() => undefined);
    await admin?.end({ timeout: 2 });
  });

  beforeEach(() => {
    resetConnectRouteLimits();
    delete process.env['MC_TRUSTED_PUBLIC_HOSTS'];
    connectConfig.lockTimeoutMs = 5000;
  });

  async function register(redirectUris: unknown = [REDIRECT]) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/connect/register',
      payload: { client_name: 'review-gatherer', redirect_uris: redirectUris, token_endpoint_auth_method: 'client_secret_post' },
    });
  }

  async function client() {
    const res = await register();
    expect(res.statusCode).toBe(201);
    return res.json() as { client_id: string; client_secret: string };
  }

  function authorizeUrl(clientId: string, extra: Record<string, string> = {}, raw = '') {
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT,
      scope: SCOPE,
      state: 'the-state',
      code_challenge: pkceChallenge(VERIFIER),
      code_challenge_method: 'S256',
      ...extra,
    });
    return `/api/v1/connect/authorize?${q.toString()}${raw}`;
  }

  /** authorize → consent (approve) → the code on the redirect. */
  async function approve(clientId: string, extra: Record<string, string> = {}) {
    const res = await app.inject({ method: 'GET', url: authorizeUrl(clientId, extra) });
    expect(res.statusCode).toBe(302);
    const loc = new URL(res.headers.location as string, TEST_PUBLIC_URL);
    expect(loc.pathname).toBe('/connect/consent');
    const requestId = loc.searchParams.get('request')!;
    const decided = await app.inject({
      method: 'POST',
      url: `/api/v1/connect/requests/${requestId}/decision`,
      headers: { cookie: person.cookie, origin: TEST_PUBLIC_URL },
      payload: { decision: 'approve' },
    });
    expect(decided.statusCode).toBe(200);
    const back = new URL(decided.json().redirect as string);
    expect(back.origin + back.pathname).toBe(REDIRECT);
    expect(back.searchParams.get('state')).toBe('the-state');
    return back.searchParams.get('code')!;
  }

  async function exchange(c: { client_id: string; client_secret: string }, code: string, verifier = VERIFIER) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/connect/token',
      headers: FORM,
      payload: form({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: c.client_id, client_secret: c.client_secret, code_verifier: verifier }),
    });
  }

  async function refresh(c: { client_id: string; client_secret: string }, refreshToken: string) {
    const basic = Buffer.from(`${c.client_id}:${c.client_secret}`).toString('base64');
    return app.inject({
      method: 'POST',
      url: '/api/v1/connect/token',
      headers: { ...FORM, authorization: `Basic ${basic}` },
      payload: form({ grant_type: 'refresh_token', refresh_token: refreshToken }),
    });
  }

  async function linked() {
    const c = await client();
    const res = await exchange(c, await approve(c.client_id));
    expect(res.statusCode).toBe(200);
    return { c, tokens: res.json() as { access_token: string; refresh_token: string; scope: string; expires_in: number } };
  }

  const auditActions = async () =>
    (await handle.sql<Array<{ action: string }>>`select action from audit_log where action like 'mc.%' order by at, action`).map((r) => r.action);

  it('serves the manifest: public, valid, auth URLs absolute on PUBLIC_URL', async () => {
    const res = await app.inject({ method: 'GET', url: '/.well-known/music-connections' });
    expect(res.statusCode).toBe(200);
    const m = ManifestSchema.parse(res.json());
    expect(m.service).toBe('tagave');
    expect(m.auth).toEqual({
      authorize: `${TEST_PUBLIC_URL}/api/v1/connect/authorize`,
      token: `${TEST_PUBLIC_URL}/api/v1/connect/token`,
      register: `${TEST_PUBLIC_URL}/api/v1/connect/register`,
    });
    expect(Object.keys(m.provides).sort()).toEqual(['collection', 'identity', 'listens', 'ratings']);
    expect([...m.consumes].sort()).toEqual(['critic-scores', 'identity', 'wantlist-suggestions']);
  });

  it('every access token it issues is known-good at once, so its first feed request skips a flooded queue', async () => {
    const { c, tokens } = await linked();
    expect(knownGoodTokens.has(hashToken(tokens.access_token))).toBe(true);
    const r = await refresh(c, tokens.refresh_token);
    expect(r.statusCode).toBe(200);
    expect(knownGoodTokens.has(hashToken(r.json().access_token))).toBe(true);
  });

  it('links end to end: register → authorize → consent → token → refresh → revoke', async () => {
    const c = await client();
    // the secret is stored hashed
    const [stored] = await handle.sql`select client_secret_hash from mc_oauth_clients where client_id = ${c.client_id}`;
    expect(stored!['client_secret_hash']).toBe(hashToken(c.client_secret));

    // the consent page's view: client name, redirect host, each scope in words
    const res = await app.inject({ method: 'GET', url: authorizeUrl(c.client_id) });
    const requestId = new URL(res.headers.location as string, TEST_PUBLIC_URL).searchParams.get('request')!;
    const anon = await app.inject({ method: 'GET', url: `/api/v1/connect/requests/${requestId}` });
    expect(anon.statusCode).toBe(401);
    const view = await app.inject({ method: 'GET', url: `/api/v1/connect/requests/${requestId}`, headers: { cookie: person.cookie } });
    expect(view.statusCode).toBe(200);
    expect(view.json()).toMatchObject({ client: { name: 'review-gatherer', redirectHost: '192.168.77.50:8080' } });
    expect(view.json().scopes.map((s: { scope: string }) => s.scope)).toEqual(SCOPE.split(' '));
    for (const s of view.json().scopes) expect(s.label).not.toBe(s.scope);

    const decided = await app.inject({
      method: 'POST', url: `/api/v1/connect/requests/${requestId}/decision`,
      headers: { cookie: person.cookie }, payload: { decision: 'approve' },
    });
    const code = new URL(decided.json().redirect).searchParams.get('code')!;
    // answered once
    const again = await app.inject({
      method: 'POST', url: `/api/v1/connect/requests/${requestId}/decision`,
      headers: { cookie: person.cookie }, payload: { decision: 'approve' },
    });
    expect(again.statusCode).toBe(404);

    const tok = await exchange(c, code);
    expect(tok.statusCode).toBe(200);
    expect(tok.headers['cache-control']).toBe('no-store');
    const t = tok.json();
    expect(t).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: SCOPE });
    expect(typeof t.refresh_token).toBe('string');

    // the lookup the /mc/v1 feeds use; only hashes in the table
    const grant = await lookupAccessToken(handle.sql, t.access_token);
    expect(grant).toMatchObject({ userId: person.userId, clientId: c.client_id, scopes: SCOPE.split(' ') });
    expect(grant!.expiresAt.getTime()).toBeGreaterThan(Date.now() + 3500_000);
    const raw = await handle.sql`select access_token_hash, refresh_token_hash from mc_oauth_tokens`;
    expect(JSON.stringify(raw)).not.toContain(t.access_token);
    expect(JSON.stringify(raw)).not.toContain(t.refresh_token);

    const r1 = await refresh(c, t.refresh_token);
    expect(r1.statusCode).toBe(200);
    const t2 = r1.json();
    expect(t2.refresh_token).not.toBe(t.refresh_token);
    expect(await lookupAccessToken(handle.sql, t2.access_token)).toMatchObject({ userId: person.userId });

    const rev = await app.inject({
      method: 'POST', url: '/api/v1/connect/revoke', headers: FORM,
      payload: form({ token: t2.refresh_token, client_id: c.client_id, client_secret: c.client_secret }),
    });
    expect(rev.statusCode).toBe(200);
    expect(await lookupAccessToken(handle.sql, t2.access_token)).toBeNull();
    expect(await lookupAccessToken(handle.sql, t.access_token)).toBeNull();
    expect((await refresh(c, t2.refresh_token)).json()).toEqual({ error: 'invalid_grant' });
    // unknown token: still 200 (RFC 7009)
    const unknown = await app.inject({
      method: 'POST', url: '/api/v1/connect/revoke', headers: FORM,
      payload: form({ token: 'mca_nothing', client_id: c.client_id, client_secret: c.client_secret }),
    });
    expect(unknown.statusCode).toBe(200);

    const actions = await auditActions();
    for (const a of ['mc.client.register', 'mc.link.approve', 'mc.link.revoke']) expect(actions).toContain(a);
    const [entry] = await handle.sql`select actor_user_id, library_id, payload from audit_log where action = 'mc.link.approve' limit 1`;
    expect(entry).toMatchObject({ actor_user_id: person.userId, library_id: null });
    expect(JSON.stringify(entry!['payload'])).not.toContain(code);
  });

  it('a reused rotated refresh token revokes the whole family', async () => {
    const { c, tokens } = await linked();
    const r1 = await refresh(c, tokens.refresh_token);
    expect(r1.statusCode).toBe(200);
    const fresh = r1.json();
    const replay = await refresh(c, tokens.refresh_token);
    expect(replay.statusCode).toBe(400);
    expect(replay.json()).toEqual({ error: 'invalid_grant' });
    expect(await lookupAccessToken(handle.sql, fresh.access_token)).toBeNull();
    expect((await refresh(c, fresh.refresh_token)).json()).toEqual({ error: 'invalid_grant' });
    expect(await auditActions()).toContain('mc.refresh.reuse');
  });

  it('two refreshes of one token at once: one wins, the other is reuse', async () => {
    const { c, tokens } = await linked();
    const [a, b] = await Promise.all([refresh(c, tokens.refresh_token), refresh(c, tokens.refresh_token)]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 400]);
    const won = (a.statusCode === 200 ? a : b).json();
    expect(await lookupAccessToken(handle.sql, won.access_token)).toBeNull();
  });

  it('a refresh waits for the lock at most the timeout, then answers 503', async () => {
    const { c, tokens } = await linked();
    connectConfig.lockTimeoutMs = 300;
    const holder = postgres(db.url, { max: 1, onnotice: () => undefined });
    try {
      await holder`select pg_advisory_lock(hashtextextended(${`mc-refresh:${hashToken(tokens.refresh_token)}`}, 0))`;
      const res = await refresh(c, tokens.refresh_token);
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ error: 'temporarily_unavailable' });
      expect(res.headers['retry-after']).toBe('1');
    } finally {
      await holder.end({ timeout: 2 });
    }
    // nothing was consumed
    expect((await refresh(c, tokens.refresh_token)).statusCode).toBe(200);
  });

  it('a code works once; its second use revokes what it gave', async () => {
    const c = await client();
    const code = await approve(c.client_id);
    const first = await exchange(c, code);
    expect(first.statusCode).toBe(200);
    const second = await exchange(c, code);
    expect(second.json()).toEqual({ error: 'invalid_grant' });
    expect(await lookupAccessToken(handle.sql, first.json().access_token)).toBeNull();
  });

  it('refuses a wrong PKCE verifier, the wrong client and a wrong secret', async () => {
    const c = await client();
    const other = await client();
    expect((await exchange(c, await approve(c.client_id), 'w'.repeat(43))).json()).toEqual({ error: 'invalid_grant' });
    expect((await exchange(other, await approve(c.client_id))).json()).toEqual({ error: 'invalid_grant' });
    const wrong = await exchange({ client_id: c.client_id, client_secret: 'mcs_wrong' }, await approve(c.client_id));
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toEqual({ error: 'invalid_client' });
  });

  it('without offline_access there is no refresh token, and only the granted scopes', async () => {
    const c = await client();
    const res = await exchange(c, await approve(c.client_id, { scope: 'ratings:read' }));
    const t = res.json();
    expect(t.refresh_token).toBeUndefined();
    expect(t.scope).toBe('ratings:read');
    const grant = await lookupAccessToken(handle.sql, t.access_token);
    expect(grant!.scopes).toEqual(['ratings:read']);
    // an out-of-scope feed call: the grant carries no listens:read
    expect(grant!.scopes.includes('listens:read')).toBe(false);
  });

  it('denying sends access_denied back and issues nothing', async () => {
    const c = await client();
    const res = await app.inject({ method: 'GET', url: authorizeUrl(c.client_id) });
    const requestId = new URL(res.headers.location as string, TEST_PUBLIC_URL).searchParams.get('request')!;
    const decided = await app.inject({
      method: 'POST', url: `/api/v1/connect/requests/${requestId}/decision`,
      headers: { cookie: person.cookie }, payload: { decision: 'deny' },
    });
    const back = new URL(decided.json().redirect);
    expect(back.searchParams.get('error')).toBe('access_denied');
    expect(back.searchParams.get('code')).toBeNull();
  });

  it('a decision from another site is refused', async () => {
    const c = await client();
    const res = await app.inject({ method: 'GET', url: authorizeUrl(c.client_id) });
    const requestId = new URL(res.headers.location as string, TEST_PUBLIC_URL).searchParams.get('request')!;
    const decided = await app.inject({
      method: 'POST', url: `/api/v1/connect/requests/${requestId}/decision`,
      headers: { cookie: person.cookie, origin: 'https://evil.example' }, payload: { decision: 'approve' },
    });
    expect(decided.statusCode).toBe(403);
  });

  describe('registration allow-list', () => {
    it('refuses a host that is not on the allow-list', async () => {
      expect((await register(['https://music.example.com/cb'])).statusCode).toBe(400);
      expect((await register(['http://8.8.8.8/cb'])).statusCode).toBe(400);
    });

    it('takes LAN, tailnet and loopback over http', async () => {
      for (const u of ['http://10.1.2.3/cb', 'http://172.20.0.5:3000/cb', 'http://100.101.102.103/cb', 'http://127.0.0.1:9/cb', 'http://localhost:5173/cb']) {
        expect((await register([u])).statusCode).toBe(201);
      }
      expect((await register(['http://100.128.0.1/cb'])).statusCode).toBe(400);
    });

    it('takes a trusted public host over https only', async () => {
      process.env['MC_TRUSTED_PUBLIC_HOSTS'] = 'music.example.com';
      expect((await register(['https://music.example.com/cb'])).statusCode).toBe(201);
      expect((await register(['http://music.example.com/cb'])).statusCode).toBe(400);
    });

    it('refuses a second redirect URI, and a non-canonical one', async () => {
      expect((await register([REDIRECT, 'http://192.168.77.51/cb'])).statusCode).toBe(400);
      expect((await register([])).statusCode).toBe(400);
      expect((await register(['http://192.168.77.50:8080/cb#frag'])).statusCode).toBe(400);
      expect((await register(['http://192.168.77.50:8080/a,http://evil.example/'])).statusCode).toBe(400);
      expect((await register(['HTTP://192.168.77.50/cb'])).statusCode).toBe(400);
    });
  });

  describe('authorize refusals', () => {
    let clientId: string;
    beforeAll(async () => {
      resetConnectRouteLimits();
      clientId = (await client()).client_id;
    });
    const status = async (url: string) => (await app.inject({ method: 'GET', url })).statusCode;

    it('a repeated scope parameter is 400', async () => {
      expect(await status(authorizeUrl(clientId, {}, '&scope=ratings%3Aread'))).toBe(400);
    });
    it('openid is 400', async () => {
      expect(await status(authorizeUrl(clientId, { scope: 'openid ratings:read' }))).toBe(400);
    });
    it('offline_access alone is 400', async () => {
      expect(await status(authorizeUrl(clientId, { scope: 'offline_access' }))).toBe(400);
    });
    it('a scope tagave does not grant is 400', async () => {
      expect(await status(authorizeUrl(clientId, { scope: 'critic-scores:read' }))).toBe(400);
      expect(await status(authorizeUrl(clientId, { scope: 'ratings:write' }))).toBe(400);
    });
    it('a redirect URI other than the registered one is 400 and never followed', async () => {
      const res = await app.inject({ method: 'GET', url: authorizeUrl(clientId, { redirect_uri: 'http://192.168.77.51/cb' }) });
      expect(res.statusCode).toBe(400);
      expect(res.headers.location).toBeUndefined();
    });
    it('no PKCE, or plain PKCE, is 400', async () => {
      expect(await status(authorizeUrl(clientId, { code_challenge_method: 'plain' }))).toBe(400);
      expect(await status(authorizeUrl(clientId, { code_challenge: 'short' }))).toBe(400);
    });
    it('an unknown client is 400', async () => {
      expect(await status(authorizeUrl('mcc_unknown'))).toBe(400);
    });
  });

  it('offers no userinfo or end-session endpoint', async () => {
    for (const url of ['/api/v1/connect/userinfo', '/api/v1/connect/endsession', '/api/auth/oauth2/userinfo', '/api/auth/oauth2/endsession', '/api/auth/oauth2/authorize']) {
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(404);
    }
  });
  describe('with Music Connections turned off (Settings › Modules)', () => {
    const off = async <T>(fn: () => Promise<T>): Promise<T> => {
      await setMcEnabled(handle.sql, false);
      try { return await fn(); } finally { await setMcEnabled(handle.sql, true); }
    };
    /** authorize while on, so there is an open request to look at. */
    async function openRequestId(clientId: string) {
      const res = await app.inject({ method: 'GET', url: authorizeUrl(clientId) });
      expect(res.statusCode).toBe(302);
      return new URL(res.headers.location as string, TEST_PUBLIC_URL).searchParams.get('request')!;
    }

    it('register is 404 off and 201 on', async () => {
      expect((await off(() => register())).statusCode).toBe(404);
      expect((await register()).statusCode).toBe(201);
    });

    it('authorize is 404 off (no request is made) and 302 on', async () => {
      const c = await client();
      const before = (await handle.sql`select count(*)::int as n from mc_oauth_requests`)[0]!.n;
      const res = await off(() => app.inject({ method: 'GET', url: authorizeUrl(c.client_id) }));
      expect(res.statusCode).toBe(404);
      expect(res.headers.location).toBeUndefined();
      expect((await handle.sql`select count(*)::int as n from mc_oauth_requests`)[0]!.n).toBe(before);
      expect((await app.inject({ method: 'GET', url: authorizeUrl(c.client_id) })).statusCode).toBe(302);
    });

    it('the consent request and its decision are 404 off, and work on', async () => {
      const c = await client();
      const id = await openRequestId(c.client_id);
      const view = () => app.inject({ method: 'GET', url: `/api/v1/connect/requests/${id}`, headers: { cookie: person.cookie } });
      const decide = () => app.inject({
        method: 'POST',
        url: `/api/v1/connect/requests/${id}/decision`,
        headers: { cookie: person.cookie, origin: TEST_PUBLIC_URL },
        payload: { decision: 'approve' },
      });
      const [v, d] = await off(async () => [await view(), await decide()]);
      expect(v.statusCode).toBe(404);
      expect(v.json().detail).toMatch(/turned off/);
      expect(d.statusCode).toBe(404);
      // nothing was decided while off
      expect((await view()).statusCode).toBe(200);
      expect((await decide()).statusCode).toBe(200);
    });

    it('the token endpoint issues nothing off (503, both grants), and works on again', async () => {
      const { c, tokens } = await linked();
      const code = await approve(c.client_id);
      const [byCode, byRefresh] = await off(async () => [await exchange(c, code), await refresh(c, tokens.refresh_token)]);
      for (const res of [byCode, byRefresh]) {
        expect(res.statusCode).toBe(503);
        expect(res.json().error).toBe('temporarily_unavailable');
        expect(res.headers['retry-after']).toBe('3600');
        expect(res.headers['cache-control']).toBe('no-store');
      }
      // the refresh token was not spent: it still works once the module is on
      expect((await refresh(c, tokens.refresh_token)).statusCode).toBe(200);
      expect((await exchange(c, code)).statusCode).toBe(200);
    });

    it('a wrong client secret is still 401 off', async () => {
      const { c, tokens } = await linked();
      const res = await off(() => refresh({ ...c, client_secret: 'mcs_wrong' }, tokens.refresh_token));
      expect(res.statusCode).toBe(401);
    });

    it('revoke works off: the linked app can still give its approval back', async () => {
      const { c, tokens } = await linked();
      const res = await off(() => app.inject({
        method: 'POST',
        url: '/api/v1/connect/revoke',
        headers: FORM,
        payload: form({ token: tokens.refresh_token, client_id: c.client_id, client_secret: c.client_secret }),
      }));
      expect(res.statusCode).toBe(200);
      expect(await lookupAccessToken(handle.sql, tokens.access_token)).toBeNull();
      expect((await refresh(c, tokens.refresh_token)).statusCode).toBe(400);
    });

    it('is off by default: an install that never set it offers nothing', async () => {
      await handle.sql`update libraries set settings = settings #- '{modules,mc}'`;
      try {
        expect(await mcEnabled(handle.sql)).toBe(false);
        expect((await app.inject({ method: 'GET', url: '/.well-known/music-connections' })).statusCode).toBe(404);
        expect((await register()).statusCode).toBe(404);
      } finally {
        await setMcEnabled(handle.sql, true);
      }
      expect(await mcEnabled(handle.sql)).toBe(true);
    });

    it('the manifest is 404 off and 200 on', async () => {
      const m = () => app.inject({ method: 'GET', url: '/.well-known/music-connections' });
      expect((await off(m)).statusCode).toBe(404);
      expect((await m()).statusCode).toBe(200);
    });
  });
});
