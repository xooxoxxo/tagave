/**
 * Settings › Connections against the real server on a scratch database, no
 * live network: every outbound request goes through @tagave/core/mc (the
 * URL and address checks run) and is carried by a test transport, either to
 * this same tagave (app.inject: tagave links to its own provider) or to a
 * fake review-gatherer at a LAN address.
 *
 * Covered: the full link flow (manifest → register → authorize → consent →
 * callback → token), scope derivation, sealed tokens, audit entries,
 * re-approval with a scope change, Edit URL (cursors kept, tokens dropped,
 * needs_reapproval), revoke, Sync now, one person's links invisible to
 * another, and the refusals (off-origin endpoints, hosts off the allow-list,
 * generic errors, the rate limit).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import postgres from 'postgres';
import { setRemoteFetch, openTokens } from '@tagave/core/mc';
import type { AuthHandle } from '@tagave/auth';
import { registerApiRoutes } from '../app.js';
import { initAuth } from '../middleware/auth.js';
import { TEST_APP_SECRET, TEST_PUBLIC_URL, createScratchDb, migrateAll, testAuth } from '../testkit/authApp.js';
import { createTestUser, type TestUser } from '../testkit/users.js';
import { turnMcOn } from '../testkit/mc.js';
import { resetConnectRouteLimits } from './connect.js';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PgBoss } from 'pg-boss';
import { COULD_NOT_REACH, enqueueLinkPull, mcConnectionsConfig, resetConnectionRouteLimits, type EnqueueResult } from './mcConnections.js';

const adminUrl = process.env.TEST_DATABASE_URL;
const RG = 'http://192.168.77.50:8080';
const RG_MOVED = 'http://192.168.77.60:8080';
const CALLBACK = `${TEST_PUBLIC_URL}/api/v1/me/connections/callback`;

type Call = { url: string; method: string; headers: Record<string, string>; body: string };

/** A fake review-gatherer: its manifest, registration and token endpoint. */
function fakeRg(origin = RG) {
  const state = {
    manifest: {
      protocol: 'music-connections/1', service: 'review-gatherer', version: '0.4.0',
      auth: { authorize: '/connect/authorize', token: '/connect/token', register: '/connect/register' },
      provides: { 'critic-scores': '/mc/v1/critic-scores', identity: '/mc/v1/identity', 'wantlist-suggestions': '/mc/v1/wantlist-suggestions' } as Record<string, string>,
      consumes: ['ratings', 'collection', 'listens', 'identity'],
    } as Record<string, unknown>,
    grantScope: null as string | null,
    tokenStatus: 200,
    n: 0,
    calls: [] as Call[],
  };
  const handle = (url: string, init: RequestInit): Response => {
    const u = new URL(url);
    const headers = Object.fromEntries(new Headers(init.headers));
    state.calls.push({ url, method: init.method ?? 'GET', headers, body: typeof init.body === 'string' ? init.body : '' });
    if (u.origin !== origin) return new Response('not here', { status: 404 });
    if (u.pathname === '/.well-known/music-connections') return Response.json(state.manifest);
    if (u.pathname === '/connect/register') {
      state.n++;
      return Response.json({ client_id: `rg-client-${state.n}`, client_secret: `rg-secret-${state.n}` }, { status: 201 });
    }
    if (u.pathname === '/connect/token') {
      if (state.tokenStatus !== 200) return Response.json({ error: 'invalid_grant' }, { status: state.tokenStatus });
      const p = new URLSearchParams(typeof init.body === 'string' ? init.body : '');
      const scope = state.grantScope ?? p.get('scope') ?? undefined;
      return Response.json({ access_token: `rg-access-${state.n}`, refresh_token: `rg-refresh-${state.n}`, token_type: 'Bearer', expires_in: 3600, ...(scope ? { scope } : {}) });
    }
    if (u.pathname === '/connect/revoke') return Response.json({});
    return new Response('nope', { status: 404 });
  };
  return { state, handle };
}

describe.skipIf(!adminUrl)('Settings › Connections (integration)', () => {
  let admin: postgres.Sql;
  let db: { url: string; name: string };
  let handle: AuthHandle;
  let app: FastifyInstance;
  let person: TestUser;
  let other: TestUser;
  let rg: ReturnType<typeof fakeRg>;
  let moved: ReturnType<typeof fakeRg>;
  const queued: string[] = [];
  let nextEnqueue: EnqueueResult = { queued: true };

  /** Carry a checked request: to this tagave through app.inject, else to the fakes. */
  const transport = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const u = new URL(url);
    if (u.origin === RG) return rg.handle(url, init);
    if (u.origin === RG_MOVED) return moved.handle(url, init);
    if (u.origin !== TEST_PUBLIC_URL) throw new TypeError('fetch failed');
    const res = await app.inject({
      method: (init.method ?? 'GET') as 'GET',
      url: u.pathname + u.search,
      headers: Object.fromEntries(new Headers(init.headers)),
      ...(typeof init.body === 'string' ? { payload: init.body } : {}),
    });
    const h = new Headers();
    for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) h.set(k, Array.isArray(v) ? v.join(', ') : String(v));
    const empty = res.statusCode === 204 || res.statusCode === 304;
    return new Response(empty ? null : res.rawPayload, { status: res.statusCode, headers: h });
  };

  beforeAll(async () => {
    admin = postgres(adminUrl!, { max: 1, onnotice: () => undefined });
    db = await createScratchDb(adminUrl!, admin);
    await migrateAll(db.url);
    handle = testAuth(db.url);
    initAuth(handle);
    person = await createTestUser(handle, { role: 'listener' });
    other = await createTestUser(handle, { role: 'listener' });
    await turnMcOn(handle.sql, person.userId);
    app = Fastify({ logger: false });
    await app.register(fastifyCookie);
    await registerApiRoutes(app, { backupService: { dir: '/nonexistent' } as never });
    await app.ready();
    mcConnectionsConfig.enqueuePull = async (id) => { queued.push(id); return nextEnqueue; };
  });

  afterAll(async () => {
    setRemoteFetch(undefined);
    await app?.close();
    await handle?.close();
    if (db) await admin.unsafe(`drop database if exists ${db.name} with (force)`).catch(() => undefined);
    await admin?.end({ timeout: 2 });
  });

  beforeEach(async () => {
    resetConnectRouteLimits();
    resetConnectionRouteLimits();
    delete process.env['MC_TRUSTED_PUBLIC_HOSTS'];
    rg = fakeRg();
    moved = fakeRg(RG_MOVED);
    setRemoteFetch(transport);
    queued.length = 0;
    nextEnqueue = { queued: true };
    await handle.sql`delete from mc_links`;
    await handle.sql`delete from mc_pending`;
    await handle.sql`delete from audit_log where action like 'mc.consumer.%'`;
  });

  const as = (u: TestUser) => ({ cookie: u.cookie, origin: TEST_PUBLIC_URL });
  const start = (url: string, u: TestUser = person) => app.inject({ method: 'POST', url: '/api/v1/me/connections', headers: as(u), payload: { url } });
  const list = async (u: TestUser = person) => (await app.inject({ method: 'GET', url: '/api/v1/me/connections', headers: { cookie: u.cookie } })).json();
  const callback = (q: Record<string, string>, u: TestUser = person) =>
    app.inject({ method: 'GET', url: `/api/v1/me/connections/callback?${new URLSearchParams(q)}`, headers: { cookie: u.cookie } });
  const audits = async () => (await handle.sql<Array<{ action: string; payload: Record<string, unknown> }>>`
    select action, payload from audit_log where action like 'mc.consumer.%' order by at, action`);

  /** Add the fake review-gatherer: start, then the remote sends the browser back with a code. */
  async function linkRg(u: TestUser = person) {
    const res = await start(`${RG}/`, u);
    expect(res.statusCode).toBe(200);
    const authorize = new URL(res.json().authorizeUrl);
    const back = await callback({ code: 'the-code', state: authorize.searchParams.get('state')! }, u);
    expect(back.statusCode).toBe(303);
    const loc = new URL(back.headers.location as string, TEST_PUBLIC_URL);
    expect(loc.pathname).toBe('/settings/connections');
    return { authorize, linkId: loc.searchParams.get('linked')! };
  }

  it('links tagave to its own provider end to end: manifest, register, consent, callback, token', async () => {
    const res = await start(TEST_PUBLIC_URL);
    expect(res.statusCode).toBe(200);
    const authorize = new URL(res.json().authorizeUrl);
    expect(authorize.origin + authorize.pathname).toBe(`${TEST_PUBLIC_URL}/api/v1/connect/authorize`);
    // tagave consumes critic-scores, identity, wantlist-suggestions; a tagave provides only identity of those
    expect(authorize.searchParams.get('scope')).toBe('identity:read offline_access');
    expect(authorize.searchParams.get('redirect_uri')).toBe(CALLBACK);
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    // the browser: authorize → consent page → approve
    const a = await app.inject({ method: 'GET', url: authorize.pathname + authorize.search });
    expect(a.statusCode).toBe(302);
    const requestId = new URL(a.headers.location as string, TEST_PUBLIC_URL).searchParams.get('request')!;
    const decided = await app.inject({ method: 'POST', url: `/api/v1/connect/requests/${requestId}/decision`, headers: as(person), payload: { decision: 'approve' } });
    expect(decided.statusCode).toBe(200);
    const target = new URL(decided.json().redirect);
    expect(target.origin + target.pathname).toBe(CALLBACK);
    const back = await app.inject({ method: 'GET', url: target.pathname + target.search, headers: { cookie: person.cookie } });
    expect(back.statusCode).toBe(303);
    const linkId = new URL(back.headers.location as string, TEST_PUBLIC_URL).searchParams.get('linked');
    expect(linkId).toBeTruthy();
    expect(queued).toEqual([linkId]);

    const [row] = await handle.sql`select * from mc_links where id = ${linkId}`;
    expect(row).toMatchObject({ remote_url: TEST_PUBLIC_URL, state: 'active', scopes: ['identity:read'], requested_scopes: ['identity:read'] });
    // sealed: the token is real (the provider knows its hash) and nowhere in plain text
    const tokens = openTokens(row!['sealed_tokens'] as string, TEST_APP_SECRET)!;
    expect(tokens.access_token).toMatch(/^mca_/);
    expect(JSON.stringify(row)).not.toContain(tokens.access_token);
    expect(JSON.stringify(row)).not.toContain(tokens.refresh_token);
    const feed = await app.inject({ method: 'GET', url: '/mc/v1/identity', headers: { authorization: `Bearer ${tokens.access_token}` } });
    expect(feed.statusCode).toBe(200);

    const view = await list();
    expect(view.ownUrl).toBe(TEST_PUBLIC_URL);
    expect(view.links).toHaveLength(1);
    expect(view.links[0]).toMatchObject({ service: 'tagave', state: 'active', capabilities: [{ capability: 'identity', status: 'granted' }] });
    expect((await audits()).map((r) => r.action)).toEqual(['mc.consumer.link_approve', 'mc.consumer.link_create']);
  });

  it('asks a review-gatherer for its three capabilities, write scope with wantlist suggestions, and seals what comes back', async () => {
    const { authorize, linkId } = await linkRg();
    expect(authorize.origin + authorize.pathname).toBe(`${RG}/connect/authorize`);
    expect(authorize.searchParams.get('scope')).toBe('critic-scores:read identity:read wantlist-suggestions:read wantlist-suggestions:write offline_access');
    const reg = rg.state.calls.find((c) => c.url.endsWith('/connect/register'))!;
    expect(JSON.parse(reg.body)).toMatchObject({ client_name: 'tagave', redirect_uris: [CALLBACK], token_endpoint_auth_method: 'client_secret_post' });
    expect(reg.headers['user-agent']).toMatch(/^tagave\/\S+ \(music-connections\/1\)$/);
    const tok = rg.state.calls.find((c) => c.url.endsWith('/connect/token'))!;
    const p = new URLSearchParams(tok.body);
    expect(p.get('grant_type')).toBe('authorization_code');
    expect(p.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(p.get('client_secret')).toBe('rg-secret-1');
    const [row] = await handle.sql`select * from mc_links where id = ${linkId}`;
    expect(row!['scopes']).toEqual(['critic-scores:read', 'identity:read', 'wantlist-suggestions:read', 'wantlist-suggestions:write']);
    expect(JSON.stringify(row)).not.toContain('rg-access-1');
    expect(JSON.stringify(row)).not.toContain('rg-secret-1');
    // the pending authorization is single use
    expect(await handle.sql`select 1 from mc_pending`).toHaveLength(0);
    // the verifier sent at the exchange matches the challenge sent to authorize
    expect(createHash('sha256').update(p.get('code_verifier')!).digest('base64url')).toBe(authorize.searchParams.get('code_challenge'));
    const replay = await callback({ code: 'the-code', state: authorize.searchParams.get('state')! });
    expect(replay.headers.location).toBe('/settings/connections?error=invalid_state');
  });

  it('a capability left out shows as not granted; one offered later as available, re-link to grant', async () => {
    rg.state.grantScope = 'critic-scores:read offline_access';
    const { linkId } = await linkRg();
    let caps = (await list()).links[0].capabilities;
    expect(caps).toEqual([
      { capability: 'critic-scores', status: 'granted', applied: null, skipped: null },
      { capability: 'identity', status: 'not_granted', applied: null, skipped: null },
      { capability: 'wantlist-suggestions', status: 'not_granted', applied: null, skipped: null },
    ]);
    // linked when the remote offered only critic scores; it adds identity later (the daily re-read stores it)
    await handle.sql`update mc_links set requested_scopes = '{critic-scores:read}' where id = ${linkId}`;
    caps = (await list()).links[0].capabilities;
    expect(caps.find((c: { capability: string }) => c.capability === 'identity').status).toBe('available');
  });

  it('re-approval keeps the row and its cursors and records the scope change', async () => {
    rg.state.grantScope = 'critic-scores:read offline_access';
    const { linkId } = await linkRg();
    await handle.sql`update mc_links set cursors = '{"critic-scores":"c-41"}'::jsonb, state = 'needs_reapproval' where id = ${linkId}`;
    rg.state.grantScope = null;
    const re = await app.inject({ method: 'POST', url: `/api/v1/me/connections/${linkId}/reapprove`, headers: as(person) });
    expect(re.statusCode).toBe(200);
    const state = new URL(re.json().authorizeUrl).searchParams.get('state')!;
    const back = await callback({ code: 'c2', state });
    expect(back.headers.location).toBe(`/settings/connections?linked=${linkId}`);
    const [row] = await handle.sql`select state, cursors, scopes from mc_links where id = ${linkId}`;
    expect(row).toMatchObject({ state: 'active', cursors: { 'critic-scores': 'c-41' } });
    const changes = (await audits()).filter((a) => a.action === 'mc.consumer.scope_change');
    expect(changes).toHaveLength(1);
    expect(changes[0]!.payload).toMatchObject({ added: ['identity:read', 'wantlist-suggestions:read', 'wantlist-suggestions:write'], removed: [] });
    // the spent approval's tokens went back to the host that issued them
    expect(rg.state.calls.some((c) => c.url === `${RG}/connect/revoke` && new URLSearchParams(c.body).get('token') === 'rg-refresh-1')).toBe(true);
  });

  it('an authorization in flight keeps the state hashed and the verifier and client secret sealed', async () => {
    const res = await start(RG);
    const state = new URL(res.json().authorizeUrl).searchParams.get('state')!;
    const [row] = await handle.sql`select * from mc_pending`;
    expect(row!['state_hash']).toBe(createHash('sha256').update(state).digest('hex'));
    expect(String(row!['code_verifier_sealed'])).toMatch(/^enc:v1:/);
    expect(String(row!['client_secret_sealed'])).toMatch(/^enc:v1:/);
    expect(JSON.stringify(row)).not.toContain(state);
    expect(JSON.stringify(row)).not.toContain('rg-secret-1');
  });

  it('a denial or an error from the remote comes back as ?error=, and nothing is linked', async () => {
    const res = await start(RG);
    const state = new URL(res.json().authorizeUrl).searchParams.get('state')!;
    expect((await callback({ error: 'access_denied', state })).headers.location).toBe('/settings/connections?error=access_denied');
    expect((await callback({ error: 'access_denied' })).headers.location).toBe('/settings/connections?error=access_denied');
    rg.state.tokenStatus = 400;
    const res2 = await start(RG);
    const state2 = new URL(res2.json().authorizeUrl).searchParams.get('state')!;
    const back = await callback({ code: 'x', state: state2 });
    expect(back.headers.location).toBe('/settings/connections?error=remote_error');
    expect(await handle.sql`select 1 from mc_links`).toHaveLength(0);
  });

  it('another person cannot finish, see, sync or change my link', async () => {
    const res = await start(RG);
    const state = new URL(res.json().authorizeUrl).searchParams.get('state')!;
    expect((await callback({ code: 'x', state }, other)).headers.location).toBe('/settings/connections?error=invalid_state');
    const { linkId } = await linkRg();
    expect((await list(other)).links).toEqual([]);
    for (const [method, url] of [['POST', `/api/v1/me/connections/${linkId}/sync`], ['POST', `/api/v1/me/connections/${linkId}/reapprove`], ['DELETE', `/api/v1/me/connections/${linkId}`]] as const) {
      expect((await app.inject({ method, url, headers: as(other) })).statusCode).toBe(404);
    }
    expect((await app.inject({ method: 'PATCH', url: `/api/v1/me/connections/${linkId}`, headers: as(other), payload: { url: RG_MOVED } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/v1/me/connections' })).statusCode).toBe(401);
  });

  it('Sync now queues the link, once a minute, and only while it is active', async () => {
    const { linkId } = await linkRg();
    queued.length = 0;
    const sync = () => app.inject({ method: 'POST', url: `/api/v1/me/connections/${linkId}/sync`, headers: as(person) });
    expect((await sync()).statusCode).toBe(202);
    expect(queued).toEqual([linkId]);
    expect((await sync()).statusCode).toBe(429);
    resetConnectionRouteLimits();
    // a pull already waiting: never a 202 that does nothing
    const at = new Date(Date.now() + 90_000).toISOString();
    nextEnqueue = { queued: false, retryAt: at };
    const busy = await sync();
    expect(busy.statusCode).toBe(409);
    expect(busy.json()).toMatchObject({ retryAt: at, detail: 'A sync of this connection is already waiting to run.' });
    expect(Number(busy.headers['retry-after'])).toBeGreaterThan(80);
    nextEnqueue = { queued: true };
    resetConnectionRouteLimits();
    await handle.sql`update mc_links set state = 'needs_reapproval' where id = ${linkId}`;
    expect((await sync()).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: `/api/v1/me/connections/${linkId}/sync`, headers: { cookie: person.cookie, origin: 'http://evil.example' } })).statusCode).toBe(403);
  });

  it('Edit URL keeps the cursors, drops the tokens (revoked at the old host) and asks for approval again', async () => {
    const { linkId } = await linkRg();
    await handle.sql`update mc_links set cursors = '{"critic-scores":"c-7","identity":"c-3"}'::jsonb where id = ${linkId}`;
    const res = await app.inject({ method: 'PATCH', url: `/api/v1/me/connections/${linkId}`, headers: as(person), payload: { url: `${RG_MOVED}/somewhere` } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ remoteUrl: RG_MOVED, state: 'needs_reapproval' });
    const [row] = await handle.sql`select * from mc_links where id = ${linkId}`;
    expect(row).toMatchObject({ remote_url: RG_MOVED, sealed_tokens: '', state: 'needs_reapproval', cursors: { 'critic-scores': 'c-7', identity: 'c-3' } });
    // the old tokens went back to the old host only, never to the new one
    expect(rg.state.calls.some((c) => c.url === `${RG}/connect/revoke`)).toBe(true);
    expect(moved.state.calls.map((c) => c.url)).toEqual([`${RG_MOVED}/.well-known/music-connections`]);
    expect((await audits()).map((a) => a.action)).toContain('mc.consumer.url_change');
    // re-approving at the new address lands on the same row, cursors intact
    const re = await app.inject({ method: 'POST', url: `/api/v1/me/connections/${linkId}/reapprove`, headers: as(person) });
    const back = await callback({ code: 'c', state: new URL(re.json().authorizeUrl).searchParams.get('state')! });
    expect(back.headers.location).toBe(`/settings/connections?linked=${linkId}`);
    const [after] = await handle.sql`select state, cursors from mc_links where id = ${linkId}`;
    expect(after).toMatchObject({ state: 'active', cursors: { 'critic-scores': 'c-7' } });
  });

  it('Edit URL refuses another service at the new address and keeps everything', async () => {
    const { linkId } = await linkRg();
    moved.state.manifest = { ...moved.state.manifest, service: 'something-else' };
    const res = await app.inject({ method: 'PATCH', url: `/api/v1/me/connections/${linkId}`, headers: as(person), payload: { url: RG_MOVED } });
    expect(res.statusCode).toBe(400);
    const [row] = await handle.sql`select remote_url, state, sealed_tokens from mc_links where id = ${linkId}`;
    expect(row).toMatchObject({ remote_url: RG, state: 'active' });
    expect(row!['sealed_tokens']).not.toBe('');
  });

  it('revoke clears tokens and cursors here and at the remote; a second press removes the row', async () => {
    const { linkId } = await linkRg();
    await handle.sql`update mc_links set cursors = '{"identity":"c"}'::jsonb where id = ${linkId}`;
    const del = () => app.inject({ method: 'DELETE', url: `/api/v1/me/connections/${linkId}`, headers: as(person) });
    expect((await del()).json()).toEqual({ ok: true, removed: false });
    const [row] = await handle.sql`select state, sealed_tokens, cursors from mc_links where id = ${linkId}`;
    expect(row).toMatchObject({ state: 'revoked', sealed_tokens: '', cursors: {} });
    const rev = rg.state.calls.find((c) => c.url === `${RG}/connect/revoke`)!;
    expect(new URLSearchParams(rev.body).get('token')).toBe('rg-refresh-1');
    expect((await audits()).map((a) => a.action)).toContain('mc.consumer.revoke');
    expect((await del()).json()).toEqual({ ok: true, removed: true });
    expect(await handle.sql`select 1 from mc_links where id = ${linkId}`).toHaveLength(0);
  });

  describe('refusals: no token or secret goes to another host', () => {
    it('a manifest naming an auth endpoint or any feed on another host is refused before registering', async () => {
      rg.state.manifest = { ...rg.state.manifest, auth: { authorize: '/connect/authorize', token: 'http://192.168.77.99/connect/token', register: '/connect/register' } };
      let res = await start(RG);
      expect(res.statusCode).toBe(400);
      expect(res.json().detail).toBe(COULD_NOT_REACH);
      rg = fakeRg();
      rg.state.manifest = { ...rg.state.manifest, provides: { 'critic-scores': '/mc/v1/critic-scores', ratings: 'http://10.0.0.5/mc/v1/ratings' } };
      res = await start(RG);
      expect(res.statusCode).toBe(400);
      expect(rg.state.calls.map((c) => new URL(c.url).pathname)).toEqual(['/.well-known/music-connections']);
    });

    it('hosts off the allow-list and blocked addresses are refused without a request', async () => {
      const reached: string[] = [];
      setRemoteFetch(async (url) => { reached.push(url); return new Response('{}'); });
      for (const url of ['http://example.com', 'https://example.com', 'http://169.254.169.254', 'http://0.0.0.0:8080', 'http://[::ffff:a9fe:a9fe]', 'http://8.8.8.8']) {
        const res = await start(url);
        expect(res.statusCode, url).toBe(400);
      }
      expect(reached).toEqual([]);
    });

    it('what is unreachable, not Music Connections, or redirects all read the same, with no remote body', async () => {
      const answers: Array<() => Response | Promise<Response>> = [
        () => { throw new TypeError('fetch failed'); },
        () => new Response('<html>secret admin page</html>', { status: 200 }),
        () => new Response('internal detail', { status: 500 }),
        () => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } }),
      ];
      for (const answer of answers) {
        setRemoteFetch(async () => answer());
        const res = await start('http://192.168.77.77:9000');
        expect(res.statusCode).toBe(400);
        expect(res.json().detail).toBe(COULD_NOT_REACH);
        expect(res.body).not.toContain('secret');
        expect(res.body).not.toContain('internal');
      }
    });

    it('a remote that sends headers and then breaks off reads as could not reach (manifest, registration, Edit URL)', async () => {
      let mode: 'manifest' | 'register' = 'manifest';
      const server: Server = createServer((req, res) => {
        const broken = () => { res.writeHead(200, { 'content-type': 'application/json', 'content-length': '5000' }); res.write('{"protocol":"mus'); setTimeout(() => res.destroy(), 10); };
        if (req.url === '/.well-known/music-connections') {
          if (mode === 'manifest') return broken();
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ ...rg.state.manifest }));
        }
        if (req.url === '/connect/register') return broken();
        res.writeHead(404); res.end();
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      setRemoteFetch(undefined); // the real transport, to a local socket
      try {
        let res = await start(origin);
        expect(res.statusCode).toBe(400);
        expect(res.json().detail).toBe(COULD_NOT_REACH);
        mode = 'register';
        res = await start(origin);
        expect(res.statusCode).toBe(400);
        expect(res.json().detail).toBe(COULD_NOT_REACH);
        setRemoteFetch(transport);
        const { linkId } = await linkRg();
        setRemoteFetch(undefined);
        mode = 'manifest';
        const edit = await app.inject({ method: 'PATCH', url: `/api/v1/me/connections/${linkId}`, headers: as(person), payload: { url: origin } });
        expect(edit.statusCode).toBe(400);
        expect(edit.json().detail).toBe(COULD_NOT_REACH);
      } finally {
        setRemoteFetch(transport);
        server.closeAllConnections();
        await new Promise<void>((r) => server.close(() => r()));
      }
    });

    it('adding and editing addresses is rate limited per person (10 per 10 minutes)', async () => {
      for (let i = 0; i < 10; i++) expect((await start(`http://192.168.3.${i + 1}`)).statusCode).toBe(400);
      expect((await start(RG)).statusCode).toBe(429);
      expect((await start(RG, other)).statusCode).toBe(200);
    });
  });

  it('Sync now replaces a delayed backoff retry and runs now; a pull already queued says when it starts', async () => {
    const boss = new PgBoss(db.url);
    boss.on('error', () => undefined);
    await boss.start();
    try {
      await boss.createQueue('connections.pull', { policy: 'stately' });
      await boss.deleteAllJobs('connections.pull');
      const linkId = '00000000-0000-4000-8000-0000000000aa';
      const key = `connections.pull:${linkId}`;
      // the worker's backoff retry, an hour out
      const retryId = await boss.send('connections.pull', { linkId }, { singletonKey: key, startAfter: 3600 });
      expect(retryId).toBeTruthy();
      expect(await boss.send('connections.pull', { linkId }, { singletonKey: key })).toBeNull(); // the bug: a silent no-op
      expect(await enqueueLinkPull(boss, linkId)).toEqual({ queued: true });
      const jobs = await boss.findJobs('connections.pull', { key, queued: true });
      expect(jobs).toHaveLength(1);
      expect(jobs[0]!.id).not.toBe(retryId);
      expect(new Date(jobs[0]!.startAfter).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
      // pressed again while that one waits to run: not queued, with when it starts
      const again = await enqueueLinkPull(boss, linkId);
      expect(again.queued).toBe(false);
      expect(Date.parse((again as { retryAt: string }).retryAt)).toBeLessThanOrEqual(Date.now() + 1000);
    } finally {
      await boss.stop({ graceful: false });
    }
  });

  it('a running pull is never removed; Sync now queues one behind it', async () => {
    const boss = new PgBoss(db.url);
    boss.on('error', () => undefined);
    await boss.start();
    try {
      await boss.createQueue('connections.pull', { policy: 'stately' });
      await boss.deleteAllJobs('connections.pull');
      const linkId = '00000000-0000-4000-8000-0000000000bb';
      const key = `connections.pull:${linkId}`;
      const runningId = await boss.send('connections.pull', { linkId }, { singletonKey: key });
      const [fetched] = await boss.fetch('connections.pull');
      expect(fetched!.id).toBe(runningId);
      expect(await enqueueLinkPull(boss, linkId)).toEqual({ queued: true });
      const [running] = await boss.findJobs('connections.pull', { id: runningId! });
      expect(running!.state).toBe('active');
      const queuedJobs = await boss.findJobs('connections.pull', { key, queued: true });
      expect(queuedJobs.map((j) => j.state)).toEqual(['created']);
    } finally {
      await boss.stop({ graceful: false });
    }
  });

  it('Sync now on a pull about to run says "Already syncing", not a start time', async () => {
    const { linkId } = await linkRg();
    nextEnqueue = { queued: false, retryAt: new Date().toISOString() };
    const res = await app.inject({ method: 'POST', url: `/api/v1/me/connections/${linkId}/sync`, headers: as(person) });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ title: 'Conflict', status: 409, detail: 'Already syncing.' });
  });
});
