/**
 * Settings › Modules from the app's side, against a stand-in updater that
 * checks the app's signatures: the owner sees the catalogue, the app brings
 * the updater the signed manifest it lacks, Turn on needs a fresh step-up,
 * the updater's refusals reach the page with their reason; without the
 * updater the catalogue is checked here and the commands are listed; a
 * non-owner gets 403.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import type { FastifyInstance } from 'fastify';
import type { AuthHandle } from '@tagave/auth';
import type { ModulesView } from '@tagave/shared';
import { SignatureVerifier, SIGNATURE_HEADER, TIME_HEADER } from '@tagave/updater/token';
import { signManifest } from '@tagave/updater/release';
import { TEST_APP_SECRET, TEST_PUBLIC_URL, buildAuthApp, cookieHeader, cookieJar, createScratchDb, migrateAll, testAuth } from '../testkit/authApp.js';
import { initDb } from '../db.js';
import { createModuleRoutes } from './modules.js';
import { clearReleaseFilesCache } from '../lib/releaseFiles.js';
import { resetStepUpFailures } from './stepUp.js';

const url = process.env.TEST_DATABASE_URL;
const EMAIL = 'owner@example.com';
const PASSWORD = 'correct horse battery';

const { privateKey } = generateKeyPairSync('ed25519');
const digest = (c: string) => `sha256:${c.repeat(64)}`;
const MANIFEST = `${JSON.stringify({
  schema: 1, project: 'tagave', version: '0.9.2', publishedAt: '2026-10-16T00:00:00Z', commit: 'x',
  images: { player: { ref: 'deluan/navidrome:0.64.0', env: 'TAGAVE_DIGEST_PLAYER', index: null, platforms: { 'linux/amd64': digest('a'), 'linux/arm64': digest('b') }, services: ['player'] } },
  modules: [{
    id: 'player', name: 'Player', purpose: 'Plays your albums.', minVersion: '0.9.0', profile: 'player', services: [{ name: 'player', image: 'player' }], compose: null,
    settings: [], restarts: ['app'], volumes: ['player-data'], keepsOnRemoval: 'its data', estimate: { memoryMb: 512, diskMb: 260 }, roles: ['all'],
  }],
  files: {},
}, null, 2)}\n`;
const SIGNATURE = signManifest(MANIFEST, privateKey);

describe.skipIf(!url)('module routes (integration)', () => {
  let admin: postgres.Sql;
  let db: { url: string; name: string };
  let handle: AuthHandle;
  let app: FastifyInstance;
  let fake: Server;
  let keysDir: string;
  let jar: Record<string, string>;
  let received: Array<{ method: string; path: string; body: string }> = [];
  /** The stand-in holds the manifest once the app brought it. */
  let hasManifest = false;
  let refuse: { status: number; error: string } | null = null;

  const json = () => ({ origin: TEST_PUBLIC_URL, 'content-type': 'application/json', cookie: cookieHeader(jar) });
  const get = (path: string) => app.inject({ method: 'GET', url: path, headers: { cookie: cookieHeader(jar) } });
  const post = (path: string, payload: unknown) => app.inject({ method: 'POST', url: path, headers: json(), payload: payload as object });

  beforeAll(async () => {
    process.env.ALLOW_INSECURE_HTTP = 'true';
    process.env.APP_SECRET = TEST_APP_SECRET;
    process.env.TAGAVE_BUILD_VERSION = '0.9.2';
    keysDir = await mkdtemp(join(tmpdir(), 'tagave-keys-'));
    await writeFile(join(keysDir, 'test.pem'), createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString());
    process.env.TAGAVE_RELEASE_KEYS_DIR = keysDir;
    admin = postgres(url!, { max: 1, onnotice: () => undefined });
    db = await createScratchDb(url!, admin);
    await migrateAll(db.url);
    await initDb(db.url);
    handle = testAuth(db.url);

    const verifier = new SignatureVerifier(TEST_APP_SECRET);
    fake = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const asset = /^\/v0\.9\.2\/(release-manifest\.json(?:\.sig)?)$/.exec(req.url ?? '');
        if (asset) { res.writeHead(200).end(asset[1]!.endsWith('.sig') ? SIGNATURE : MANIFEST); return; }
        const h = (n: string) => req.headers[n] as string | undefined;
        if (!verifier.verify({ method: req.method!, path: req.url!, body, time: h(TIME_HEADER), signature: h(SIGNATURE_HEADER) }).ok) {
          res.writeHead(401).end('{"error":"bad signature"}');
          return;
        }
        received.push({ method: req.method!, path: req.url!, body });
        const send = (status: number, b: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(b));
        const modules = () => ({
          version: '0.9.2', verified: hasManifest, problem: hasManifest ? null : 'the signed manifest of 0.9.2 is not here yet',
          modules: hasManifest ? [{ id: 'player', name: 'Player', purpose: 'Plays your albums.', state: 'off', estimate: { memoryMb: 512, diskMb: 260 }, keepsOnRemoval: 'its data', roles: ['all'], downloadBytes: null, available: true, reason: null, lastError: null }] : [],
          run: null,
        });
        if (req.method === 'GET' && req.url === '/v1/modules') return send(200, modules());
        if (req.method === 'POST' && req.url === '/v1/release') {
          const b = JSON.parse(body) as { manifest: string; signature: string };
          if (b.manifest !== MANIFEST || b.signature !== SIGNATURE) return send(422, { error: 'not the manifest', check: 'signature' });
          hasManifest = true;
          return send(200, modules());
        }
        if (req.method === 'POST' && req.url?.startsWith('/v1/modules/')) {
          if (refuse) return send(refuse.status, { error: refuse.error });
          return send(202, { run: { id: 'm1', kind: 'module', module: 'player', action: 'enable', status: 'running', steps: [], log: [] } });
        }
        return send(404, { error: 'not found' });
      });
    });
    await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
    process.env.TAGAVE_UPDATER_URL = base;
    process.env.TAGAVE_RELEASE_ASSETS_URL = base;

    app = await buildAuthApp(handle, async (instance) => {
      await instance.register(createModuleRoutes, { prefix: '/api/v1' });
    });
    const setup = await app.inject({ method: 'POST', url: '/api/v1/auth/setup', headers: { origin: TEST_PUBLIC_URL }, payload: { email: EMAIL, password: PASSWORD, displayName: 'Owner', contactString: EMAIL } });
    expect(setup.statusCode).toBe(201);
  });

  beforeEach(async () => {
    received = [];
    refuse = null;
    clearReleaseFilesCache();
    resetStepUpFailures();
    process.env.TAGAVE_UPDATER_URL = process.env.TAGAVE_RELEASE_ASSETS_URL;
    await handle.sql`update users set role = 'owner'`;
    const res = await app.inject({ method: 'POST', url: '/api/auth/sign-in/email', headers: { origin: TEST_PUBLIC_URL, 'content-type': 'application/json' }, payload: { email: EMAIL, password: PASSWORD } });
    jar = cookieJar(res.headers['set-cookie']);
  });

  afterAll(async () => {
    for (const k of ['TAGAVE_UPDATER_URL', 'TAGAVE_RELEASE_ASSETS_URL', 'TAGAVE_RELEASE_KEYS_DIR', 'TAGAVE_BUILD_VERSION']) delete process.env[k];
    await app?.close();
    await handle?.close();
    await new Promise((r) => fake?.close(r));
    await rm(keysDir, { recursive: true, force: true });
    if (db) await admin.unsafe(`drop database if exists ${db.name} with (force)`).catch(() => undefined);
    await admin?.end({ timeout: 2 });
  });

  it('brings the updater the signed manifest it lacks, then lists the catalogue', async () => {
    hasManifest = false;
    const res = await get('/api/v1/modules');
    expect(res.statusCode).toBe(200);
    const view = res.json() as ModulesView;
    expect(view).toMatchObject({ mode: 'updater', verified: true, version: '0.9.2' });
    expect(view.modules.map((m) => m.id)).toEqual(['player']);
    expect(received.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /v1/modules', 'POST /v1/release']);
  });

  it('turns a module on after a fresh sign-in, and passes the updater refusals on with their reason', async () => {
    hasManifest = true;
    const ok = await post('/api/v1/modules/player/enable', {});
    expect(ok.statusCode).toBe(202);
    expect(received.at(-1)).toMatchObject({ method: 'POST', path: '/v1/modules/player/enable', body: '{"deleteData":false,"deleteHistory":false}' });
    refuse = { status: 409, error: 'Dummy is being turned on' };
    expect((await post('/api/v1/modules/player/enable', {})).json()).toMatchObject({ status: 409, detail: 'Dummy is being turned on' });
    refuse = { status: 422, error: 'the release manifest does not match its signature' };
    expect((await post('/api/v1/modules/player/enable', {})).json()).toMatchObject({ status: 422, title: 'Release refused' });
    refuse = null;
    expect((await post('/api/v1/modules/player/disable', { deleteData: true })).statusCode).toBe(202);
    expect(received.at(-1)!.body).toBe('{"deleteData":true,"deleteHistory":false}');
    // the player's listens go too only with both boxes; the history box alone is refused
    expect((await post('/api/v1/modules/player/disable', { deleteData: true, deleteHistory: true })).statusCode).toBe(202);
    expect(received.at(-1)!.body).toBe('{"deleteData":true,"deleteHistory":true}');
    expect((await post('/api/v1/modules/player/disable', { deleteHistory: true })).statusCode).toBe(400);
    expect((await post('/api/v1/modules/Bad!/enable', {})).statusCode).toBe(404);
    expect((await post('/api/v1/modules/player/enable', { extra: 1 })).statusCode).toBe(400);
  });

  it('asks for a step-up on an old sign-in', async () => {
    await handle.sql`update auth_sessions set created_at = now() - make_interval(mins => 6)`;
    const res = await post('/api/v1/modules/player/enable', {});
    expect(res.statusCode).toBe(403);
    expect(res.json().title).toBe('Step-up required');
  });

  it('without the updater: the catalogue checked here, for the commands', async () => {
    delete process.env.TAGAVE_UPDATER_URL;
    const view = (await get('/api/v1/modules')).json() as ModulesView;
    expect(view).toMatchObject({ mode: 'command', verified: true, modules: [{ id: 'player', state: 'off' }] });
    expect((await post('/api/v1/modules/player/enable', {})).json().detail).toMatch(/install-tagave\.sh enable-module player/);
  });

  it('refuses a non-owner', async () => {
    for (const role of ['editor', 'listener']) {
      await handle.sql`update users set role = ${role}`;
      expect((await get('/api/v1/modules')).statusCode).toBe(403);
      expect((await post('/api/v1/modules/player/enable', {})).statusCode).toBe(403);
    }
  });
});
