/**
 * The opt-in updater from the app's side: step-up (fresh sign-in or a
 * re-verification within five minutes, enforced by the server), the owner
 * routes that talk to a (fake) updater with signed calls, and the internal
 * versions route the updater calls back.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import type { FastifyInstance } from 'fastify';
import type { AuthHandle } from '@tagave/auth';
import { SIGNATURE_HEADER, SignatureVerifier, TIME_HEADER, signRequest } from '@tagave/updater/token';
import {
  TEST_APP_SECRET,
  TEST_PUBLIC_URL,
  buildAuthApp,
  cookieHeader,
  cookieJar,
  createScratchDb,
  migrateAll,
  testAuth,
  totpFromUri,
} from '../testkit/authApp.js';
import { initDb } from '../db.js';
import { createUpdaterInternalRoutes, createUpdaterRoutes } from './updater.js';
import { resetStepUpFailures } from './stepUp.js';

const url = process.env.TEST_DATABASE_URL;
const EMAIL = 'owner@example.com';
const PASSWORD = 'correct horse battery';

type Jar = Record<string, string>;

describe.skipIf(!url)('updater routes and step-up (integration)', () => {
  let admin: postgres.Sql;
  let db: { url: string; name: string };
  let handle: AuthHandle;
  let app: FastifyInstance;
  let fake: Server;
  let received: Array<{ method: string; path: string; body: string; verified: boolean }> = [];
  let jar: Jar;

  const json = (j: Jar = jar) => ({ origin: TEST_PUBLIC_URL, 'content-type': 'application/json', cookie: cookieHeader(j) });
  const get = (path: string, j: Jar = jar) => app.inject({ method: 'GET', url: path, headers: { cookie: cookieHeader(j) } });
  const post = (path: string, payload: unknown, j: Jar = jar) => app.inject({ method: 'POST', url: path, headers: json(j), payload: payload as object });
  const age = (minutes: number) => handle.sql`update auth_sessions set created_at = now() - make_interval(mins => ${minutes})`;

  beforeAll(async () => {
    process.env.ALLOW_INSECURE_HTTP = 'true';
    process.env.APP_SECRET = TEST_APP_SECRET;
    admin = postgres(url!, { max: 1, onnotice: () => undefined });
    db = await createScratchDb(url!, admin);
    await migrateAll(db.url);
    await initDb(db.url);
    handle = testAuth(db.url);

    // A stand-in updater: checks the app's signature like the real one.
    const verifier = new SignatureVerifier(TEST_APP_SECRET);
    fake = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const h = (n: string) => req.headers[n] as string | undefined;
        const verified = verifier.verify({ method: req.method!, path: req.url!, body, time: h(TIME_HEADER), signature: h(SIGNATURE_HEADER) }).ok;
        received.push({ method: req.method!, path: req.url!, body, verified });
        if (!verified) { res.writeHead(401).end('{"error":"bad signature"}'); return; }
        res.writeHead(req.method === 'POST' ? 202 : 200, { 'content-type': 'application/json' });
        res.end(req.method === 'POST'
          ? JSON.stringify({ run: { id: 'r1', from: '0.7.0', target: JSON.parse(body).version, status: 'running' } })
          : JSON.stringify({ version: '0.7.0', configuredVersion: '0.7.0', role: 'all', services: ['postgres', 'app'], run: null }));
      });
    });
    await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
    process.env.TAGAVE_UPDATER_URL = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;

    app = await buildAuthApp(handle, async (instance) => {
      await instance.register(createUpdaterRoutes, { prefix: '/api/v1' });
    }, async (root) => {
      await root.register(createUpdaterInternalRoutes, { prefix: '/api/v1' });
    });
    const setup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      headers: { origin: TEST_PUBLIC_URL },
      payload: { email: EMAIL, password: PASSWORD, displayName: 'Owner', contactString: EMAIL },
    });
    expect(setup.statusCode).toBe(201);
  });

  beforeEach(async () => {
    received = [];
    resetStepUpFailures();
    const res = await app.inject({ method: 'POST', url: '/api/auth/sign-in/email', headers: { origin: TEST_PUBLIC_URL, 'content-type': 'application/json' }, payload: { email: EMAIL, password: PASSWORD } });
    jar = cookieJar(res.headers['set-cookie']);
  });

  afterAll(async () => {
    delete process.env.TAGAVE_UPDATER_URL;
    await app?.close();
    await handle?.close();
    await new Promise((r) => fake?.close(r));
    if (db) await admin.unsafe(`drop database if exists ${db.name} with (force)`).catch(() => undefined);
    await admin?.end({ timeout: 2 });
  });

  it('shows the updater as installed and reachable, through a signed call', async () => {
    const res = await get('/api/v1/updater');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ installed: true, reachable: true, updater: { configuredVersion: '0.7.0' } });
    expect(received).toEqual([{ method: 'GET', path: '/v1/status', body: '', verified: true }]);
  });

  it('counts a fresh sign-in as a strong verification', async () => {
    const status = (await get('/api/v1/auth/step-up')).json();
    expect(status).toMatchObject({ fresh: true, methods: ['password'] });
    const res = await post('/api/v1/updater/update', { version: '0.8.0' });
    expect(res.statusCode).toBe(202);
    expect(received.at(-1)).toMatchObject({ method: 'POST', path: '/v1/update', body: '{"version":"0.8.0"}', verified: true });
  });

  it('refuses to start an update on a sign-in older than five minutes, until the owner re-verifies', async () => {
    await age(6);
    expect((await get('/api/v1/auth/step-up')).json()).toMatchObject({ fresh: false });
    const refused = await post('/api/v1/updater/update', { version: '0.8.0' });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().title).toBe('Step-up required');
    expect(received).toHaveLength(0);

    expect((await post('/api/v1/auth/step-up/password', { password: 'wrong wrong wrong' })).statusCode).toBe(401);
    expect((await post('/api/v1/updater/update', { version: '0.8.0' })).statusCode).toBe(403);

    const ok = await post('/api/v1/auth/step-up/password', { password: PASSWORD });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ fresh: true });
    expect((await post('/api/v1/updater/update', { version: '0.8.0' })).statusCode).toBe(202);

    // the re-verification also goes stale after five minutes
    await handle.sql`update auth_step_ups set verified_at = now() - interval '6 minutes'`;
    expect((await post('/api/v1/updater/update', { version: '0.8.0' })).statusCode).toBe(403);
  });

  it('pauses re-verification after five wrong answers', async () => {
    await age(6);
    for (let i = 0; i < 5; i++) expect((await post('/api/v1/auth/step-up/password', { password: `wrong ${i} wrong wrong` })).statusCode).toBe(401);
    expect((await post('/api/v1/auth/step-up/password', { password: PASSWORD })).statusCode).toBe(429);
  });

  it('validates the version before anything else', async () => {
    expect((await post('/api/v1/updater/update', { version: 'latest' })).statusCode).toBe(400);
    expect(received).toHaveLength(0);
  });

  it('answers the updater on the internal route only with its signature', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/internal/updater/versions' })).statusCode).toBe(401);
    const path = '/api/v1/internal/updater/versions';
    const res = await app.inject({ method: 'GET', url: path, headers: signRequest(TEST_APP_SECRET, 'GET', path) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ app: expect.any(String), workers: [] });
    const wrong = await app.inject({ method: 'GET', url: path, headers: signRequest('0'.repeat(64), 'GET', path) });
    expect(wrong.statusCode).toBe(401);
  });

  it('with the authenticator app on, re-verifies with a code and no longer with the password', async () => {
    const enable = await post('/api/auth/two-factor/enable', { password: PASSWORD });
    const totpUri = enable.json().totpURI as string;
    const verify = await post('/api/auth/two-factor/verify-totp', { code: totpFromUri(totpUri) });
    jar = cookieJar(verify.headers['set-cookie'], jar);
    await age(6);
    expect((await get('/api/v1/auth/step-up')).json()).toMatchObject({ fresh: false, methods: ['totp'] });
    expect((await post('/api/v1/auth/step-up/password', { password: PASSWORD })).statusCode).toBe(400);
    expect((await post('/api/v1/auth/step-up/totp', { code: '000000' === totpFromUri(totpUri) ? '111111' : '000000' })).statusCode).toBe(401);
    expect((await post('/api/v1/auth/step-up/totp', { code: totpFromUri(totpUri) })).statusCode).toBe(200);
    expect((await post('/api/v1/updater/update', { version: '0.8.0' })).statusCode).toBe(202);
  });
});

describe('updater routes without the updater', () => {
  it('report it as not installed', async () => {
    const { updaterUrl } = await import('./updater.js');
    expect(updaterUrl({})).toBeNull();
    expect(updaterUrl({ TAGAVE_UPDATER_URL: 'http://updater:8080/' })).toBe('http://updater:8080');
  });
});
