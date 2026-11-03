/**
 * Get missing albums through Lidarr (the lidarr module) against the real
 * server on a scratch database and a fake Lidarr on the loopback: who may
 * call what, the key never coming back, connect / Get / Retry / Cancel and
 * their audit rows, the artist page's view, Library care › Getting, and
 * deleting the module's data.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import postgres from 'postgres';
import { getTableColumns } from 'drizzle-orm';
import { lidarrRequests, syncInstalledModules } from '@tagave/db';
import { ledgerEntries } from '@tagave/core/facets';
import { startFakeLidarr, type FakeLidarr } from '@tagave/core/lidarr-fake';
import type { AuthHandle } from '@tagave/auth';

const sent: Array<{ name: string; data: unknown; opts: { singletonKey?: string } }> = [];
vi.mock('../boss.js', () => ({ getBoss: async () => ({ send: async (name: string, data: unknown, opts: { singletonKey?: string }) => { sent.push({ name, data, opts }); return 'job'; } }) }));

const { registerApiRoutes } = await import('../app.js');
const { initAuth } = await import('../middleware/auth.js');
const { TEST_APP_SECRET, TEST_PUBLIC_URL, createScratchDb, migrateAll, testAuth } = await import('../testkit/authApp.js');
const { createTestUser } = await import('../testkit/users.js');
const { initDb } = await import('../db.js');
type TestUser = Awaited<ReturnType<typeof createTestUser>>;

const adminUrl = process.env.TEST_DATABASE_URL;
const KEY = 'f00dfacecafebeef0123456789abcdef';

describe.skipIf(!adminUrl)('lidarr: connect, Get, Retry, Cancel, the views, who may (integration)', () => {
  let admin: postgres.Sql;
  let db: { url: string; name: string };
  let handle: AuthHandle;
  let sql: postgres.Sql;
  let app: FastifyInstance;
  let lidarr: FakeLidarr;
  let owner: TestUser;
  let editor: TestUser;
  let listener: TestUser;
  let libraryId: string;
  const artistId = randomUUID();
  const artistMbid = randomUUID();
  const rgMissing = randomUUID();
  const rgMissingMbid = randomUUID();
  const rgSecond = randomUUID();
  const rgSecondMbid = randomUUID();
  const rgNoMbid = randomUUID();
  let savedSecret: string | undefined;

  const as = (u: TestUser) => ({ cookie: u.cookie, origin: TEST_PUBLIC_URL });
  const call = (u: TestUser, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
    app.inject({ method, url: `/api/v1${url}`, headers: as(u), ...(payload !== undefined ? { payload: payload as object } : {}) });

  beforeAll(async () => {
    savedSecret = process.env['APP_SECRET'];
    process.env['APP_SECRET'] = TEST_APP_SECRET;
    admin = postgres(adminUrl!, { max: 1, onnotice: () => undefined });
    db = await createScratchDb(adminUrl!, admin);
    await migrateAll(db.url);
    await initDb(db.url);
    handle = testAuth(db.url);
    initAuth(handle);
    sql = postgres(db.url, { max: 2, onnotice: () => undefined });
    await syncInstalledModules(sql, ledgerEntries());
    owner = await createTestUser(handle, { role: 'owner' });
    editor = await createTestUser(handle, { role: 'editor' });
    listener = await createTestUser(handle, { role: 'listener' });
    const [lib] = await sql<Array<{ id: string }>>`insert into libraries (owner_user_id, name, settings) values (${owner.userId}, 'Music', '{}'::jsonb) returning id::text as id`;
    libraryId = lib!.id;
    await sql`insert into scan_roots (library_id, path, display_name) values (${libraryId}, '/music', 'Music')`;
    await sql`insert into artists (id, mbid, name) values (${artistId}, ${artistMbid}, 'The Band')`;
    await sql`insert into release_groups (id, mbid, discogs_master_id, title) values (${rgMissing}, ${rgMissingMbid}, null, 'Second Album'), (${rgSecond}, ${rgSecondMbid}, null, 'Third Album'), (${rgNoMbid}, null, 4242, 'Bootleg')`;
    await sql`insert into release_group_artists (release_group_id, artist_id, position) values (${rgMissing}, ${artistId}, 0), (${rgSecond}, ${artistId}, 0), (${rgNoMbid}, ${artistId}, 0)`;
    for (const rg of [rgMissing, rgSecond, rgNoMbid]) await sql`insert into gaps (library_id, kind, subject_type, subject_id) values (${libraryId}, 'missing_album', 'release_group', ${rg})`;
    lidarr = await startFakeLidarr({ apiKey: KEY, rootFolders: ['/music', '/elsewhere'] });
    lidarr.catalog.set(rgMissingMbid, { title: 'Second Album', artistMbid, artistName: 'The Band' });
    lidarr.catalog.set(rgSecondMbid, { title: 'Third Album', artistMbid, artistName: 'The Band' });
    app = Fastify({ logger: false });
    await app.register(fastifyCookie);
    await registerApiRoutes(app, { backupService: { dir: '/nonexistent' } as never });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await lidarr?.close();
    await handle?.close();
    await sql?.end({ timeout: 2 });
    if (db) await admin.unsafe(`drop database if exists ${db.name} with (force)`).catch(() => undefined);
    await admin?.end({ timeout: 2 });
    if (savedSecret === undefined) delete process.env['APP_SECRET'];
    else process.env['APP_SECRET'] = savedSecret;
  });

  it('the drizzle schema has every column 0075 made', async () => {
    const inDb = (await sql<Array<{ c: string }>>`select column_name as c from information_schema.columns where table_name = 'lidarr_requests'`).map((r) => r.c).sort();
    expect(Object.values(getTableColumns(lidarrRequests)).map((c) => c.name).sort()).toEqual(inDb);
  });

  it('off: no Get anywhere; the settings, Get and Cancel are the owner’s alone', async () => {
    expect((await call(listener, 'GET', '/lidarr')).json()).toEqual({ available: false, canGet: false });
    expect((await call(listener, 'GET', `/libraries/${libraryId}/artists/${artistId}/lidarr`)).json()).toMatchObject({ available: false, canGet: false });
    for (const u of [editor, listener]) {
      expect((await call(u, 'GET', '/settings/lidarr')).statusCode).toBe(403);
      expect((await call(u, 'PUT', '/settings/lidarr', { enabled: true })).statusCode).toBe(403);
      expect((await call(u, 'POST', '/settings/lidarr/test', { url: lidarr.url, apiKey: KEY })).statusCode).toBe(403);
      expect((await call(u, 'POST', `/libraries/${libraryId}/lidarr/requests`, { releaseGroupId: rgMissing })).statusCode).toBe(403);
      expect((await call(u, 'POST', `/libraries/${libraryId}/artists/${artistId}/lidarr/get-all`)).statusCode).toBe(403);
      expect((await call(u, 'GET', `/libraries/${libraryId}/lidarr/requests`)).statusCode).toBe(403);
    }
    expect(lidarr.calls).toHaveLength(0);
  });

  it('Test answers the version, folders and profiles; a wrong key, a bad address and no key say so', async () => {
    const ok = await call(owner, 'POST', '/settings/lidarr/test', { url: `${lidarr.url}/`, apiKey: KEY });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({
      version: '2.9.6.4552',
      rootFolders: ['/music', '/elsewhere'],
      qualityProfiles: [{ id: 1, name: 'Any' }, { id: 2, name: 'Lossless' }],
      metadataProfiles: [{ id: 1, name: 'Standard' }, { id: 2, name: 'None' }],
    });
    const wrong = await call(owner, 'POST', '/settings/lidarr/test', { url: lidarr.url, apiKey: 'notthekey123' });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().detail).toBe('Wrong API key');
    expect((await call(owner, 'POST', '/settings/lidarr/test', { url: 'file:///etc/passwd', apiKey: KEY })).statusCode).toBe(400);
    expect((await call(owner, 'POST', '/settings/lidarr/test', { url: lidarr.url })).json().detail).toBe('Enter the API key');
    // a page elsewhere cannot use the owner's session
    expect((await app.inject({ method: 'POST', url: '/api/v1/settings/lidarr/test', headers: { cookie: owner.cookie, origin: 'https://evil.example' }, payload: { url: lidarr.url, apiKey: KEY } })).statusCode).toBe(403);
  });

  it('connect: the key is sealed, never answered; the switch is Off/On; audit rows for connect', async () => {
    const save = await call(owner, 'PUT', '/settings/lidarr/connection', { url: lidarr.url, apiKey: KEY, rootFolderPath: '/music', qualityProfileId: 2, metadataProfileId: 1 });
    expect(save.statusCode).toBe(200);
    expect(save.body).not.toContain(KEY);
    expect(save.json()).toMatchObject({ enabled: false, connection: { url: lidarr.url, keySaved: true, keyUnreadable: false, rootFolderPath: '/music', qualityProfileId: 2, version: '2.9.6.4552' }, scanRoots: ['/music'], rootFolderOutside: false });
    const [stored] = await sql<Array<{ settings: Record<string, unknown> }>>`select settings from installed_modules where id = 'lidarr'`;
    expect(String(stored!.settings['apiKey'])).toMatch(/^enc:v1:/);
    expect(JSON.stringify(stored!.settings)).not.toContain(KEY);
    // a root folder Lidarr does not have is refused
    expect((await call(owner, 'PUT', '/settings/lidarr/connection', { url: lidarr.url, rootFolderPath: '/nope', qualityProfileId: 2, metadataProfileId: 1 })).statusCode).toBe(400);
    // the root folder outside every music folder: the warning
    const outside = await call(owner, 'PUT', '/settings/lidarr/connection', { url: lidarr.url, rootFolderPath: '/elsewhere', qualityProfileId: 2, metadataProfileId: 1 });
    expect(outside.json()).toMatchObject({ rootFolderOutside: true, connection: { keySaved: true } });
    await call(owner, 'PUT', '/settings/lidarr/connection', { url: lidarr.url, rootFolderPath: '/music', qualityProfileId: 2, metadataProfileId: 1 });
    expect((await call(owner, 'PUT', '/settings/lidarr', { enabled: true })).json()).toMatchObject({ enabled: true });
    expect((await call(listener, 'GET', '/lidarr')).json()).toEqual({ available: true, canGet: false });
    expect((await call(owner, 'GET', '/lidarr')).json()).toEqual({ available: true, canGet: true });
    const audits = await sql`select action, payload from audit_log where action = 'lidarr.connect' order by at`;
    expect(audits.map((a) => a['payload']['key'])).toEqual(['set', 'kept', 'kept']);
    expect(JSON.stringify(audits)).not.toContain(KEY);
  });

  it('Test is no window onto other services: a fixed answer, no redirect, the saved key only for the saved address', async () => {
    const seen: Array<{ url: string; key: string | undefined }> = [];
    const other = createServer((req, res) => {
      seen.push({ url: req.url ?? '', key: req.headers['x-api-key'] as string | undefined });
      if (req.url?.startsWith('/hop/api/v1/')) { res.writeHead(302, { location: `${lidarr.url}/api/v1/system/status` }); res.end(); return; }
      if (req.url?.startsWith('/json/api/v1/')) { res.writeHead(200, { 'content-type': 'application/json', 'x-internal': 'TOPSECRET' }); res.end('{"secret":"TOPSECRET"}'); return; }
      res.writeHead(500, { 'content-type': 'text/html' });
      res.end('<html>TOPSECRET router admin</html>');
    });
    await new Promise<void>((r) => other.listen(0, '127.0.0.1', r));
    const otherUrl = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
    try {
      // 1. never the remote body: an HTML page, and JSON that is not Lidarr's status
      for (const [path, detail] of [['', 'Not Lidarr'], ['/json', 'Not Lidarr']] as const) {
        const res = await call(owner, 'POST', '/settings/lidarr/test', { url: `${otherUrl}${path}`, apiKey: 'attackerkey123' });
        expect(res.statusCode).toBe(400);
        expect(res.json().detail).toBe(detail);
        expect(res.body).not.toContain('TOPSECRET');
      }
      // 2. a redirect is not followed, even to a real Lidarr
      const before = lidarr.calls.length;
      const hop = await call(owner, 'POST', '/settings/lidarr/test', { url: `${otherUrl}/hop`, apiKey: KEY });
      expect(hop.json().detail).toBe('Not Lidarr');
      expect(lidarr.calls.length).toBe(before);
      // 3. no key typed: the saved key goes to the saved address only
      seen.length = 0;
      const steal = await call(owner, 'POST', '/settings/lidarr/test', { url: otherUrl });
      expect(steal.statusCode).toBe(400);
      expect(steal.json().detail).toBe('Enter the API key');
      expect(seen).toEqual([]);
      const save = await call(owner, 'PUT', '/settings/lidarr/connection', { url: otherUrl, rootFolderPath: '/music', qualityProfileId: 2, metadataProfileId: 1 });
      expect(save.statusCode).toBe(400);
      expect(seen.every((s) => s.key !== KEY)).toBe(true);
      // the same address with a trailing slash is the saved one
      expect((await call(owner, 'POST', '/settings/lidarr/test', { url: `${lidarr.url}/` })).statusCode).toBe(200);
    } finally {
      await new Promise<void>((r) => other.close(() => r()));
    }
  });

  it('the artist page: which missing albums Get can ask for (an album with no MBID cannot)', async () => {
    const v = (await call(listener, 'GET', `/libraries/${libraryId}/artists/${artistId}/lidarr`)).json();
    expect(v).toMatchObject({ available: true, canGet: false, requests: {} });
    expect([...v.gettable].sort()).toEqual([rgMissing, rgSecond].sort());
  });

  it('Get: Lidarr adds the album with its artist, monitored for it alone, and searches; a row and an audit entry', async () => {
    const before = lidarr.calls.length;
    const res = await call(owner, 'POST', `/libraries/${libraryId}/lidarr/requests`, { releaseGroupId: rgMissing });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ releaseGroupId: rgMissing, state: 'wanted', progress: null });
    expect(lidarr.albums).toHaveLength(1);
    expect(lidarr.albums[0]).toMatchObject({ foreignAlbumId: rgMissingMbid, monitored: true });
    expect(lidarr.commands).toEqual([{ name: 'AlbumSearch', albumIds: [lidarr.albums[0]!.id] }]);
    expect(lidarr.calls.slice(before).every((c) => c.keyOk && !c.url.includes(KEY))).toBe(true);
    // at most a handful of calls per Get
    expect(lidarr.calls.length - before).toBeLessThanOrEqual(4);
    expect(sent.some((s) => s.name === 'lidarr.poll')).toBe(true);
    const [row] = await sql`select state, lidarr_album_id, requested_by from lidarr_requests where release_group_id = ${rgMissing}`;
    expect(row).toMatchObject({ state: 'wanted', lidarr_album_id: lidarr.albums[0]!.id, requested_by: owner.userId });
    expect(await sql`select 1 from audit_log where action = 'lidarr.get' and actor_user_id = ${owner.userId}`).toHaveLength(1);
    // an album without a MusicBrainz id cannot be asked for
    expect((await call(owner, 'POST', `/libraries/${libraryId}/lidarr/requests`, { releaseGroupId: rgNoMbid })).statusCode).toBe(409);
    // the card's state, for everyone who can see the artist
    const v = (await call(listener, 'GET', `/libraries/${libraryId}/artists/${artistId}/lidarr`)).json();
    expect(v.requests[rgMissing]).toMatchObject({ state: 'wanted' });
  });

  it('Library care › Getting lists it with its names; Retry searches again', async () => {
    const list = (await call(owner, 'GET', `/libraries/${libraryId}/lidarr/requests`)).json();
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ title: 'Second Album', artist: 'The Band', artistId, state: 'wanted' });
    await sql`update lidarr_requests set state = 'not_found', requested_at = now() - interval '5 days'`;
    const retried = await call(owner, 'POST', `/libraries/${libraryId}/lidarr/requests/${list.items[0].id}/retry`);
    expect(retried.json()).toMatchObject({ state: 'wanted' });
    expect(lidarr.commands).toHaveLength(2);
    const [row] = await sql`select requested_at > now() - interval '1 minute' as fresh from lidarr_requests`;
    expect(row!['fresh']).toBe(true);
  });

  it('Get all missing is one job for the artist', async () => {
    const res = await call(owner, 'POST', `/libraries/${libraryId}/artists/${artistId}/lidarr/get-all`);
    expect(res.statusCode).toBe(202);
    expect(sent.find((s) => s.name === 'lidarr.get')).toMatchObject({ data: { libraryId, artistId, userId: owner.userId }, opts: { singletonKey: `lidarr.get:${libraryId}:${artistId}` } });
  });

  it('Cancel unmonitors in Lidarr (nothing is deleted there) and drops the row; an audit entry', async () => {
    const [row] = await sql<Array<{ id: string }>>`select id::text as id from lidarr_requests`;
    const res = await call(owner, 'DELETE', `/libraries/${libraryId}/lidarr/requests/${row!.id}`);
    expect(res.statusCode).toBe(204);
    expect(lidarr.albums[0]!.monitored).toBe(false);
    expect(lidarr.albums).toHaveLength(1);
    expect(lidarr.calls.some((c) => c.method === 'DELETE')).toBe(false);
    expect(await sql`select 1 from lidarr_requests`).toHaveLength(0);
    expect(await sql`select 1 from audit_log where action = 'lidarr.cancel'`).toHaveLength(1);
  });

  it('Lidarr down: Get says so (502) and records nothing', async () => {
    lidarr.failWith = 500;
    const res = await call(owner, 'POST', `/libraries/${libraryId}/lidarr/requests`, { releaseGroupId: rgSecond });
    lidarr.failWith = null;
    expect(res.statusCode).toBe(502);
    expect(res.json().detail).toBe('Lidarr refused it');
    expect(res.body).not.toContain('fake failure');
    expect(await sql`select 1 from lidarr_requests`).toHaveLength(0);
  });

  it('disconnect forgets the address and the key; delete its data empties only its table', async () => {
    await call(owner, 'POST', `/libraries/${libraryId}/lidarr/requests`, { releaseGroupId: rgSecond });
    expect(await sql`select 1 from lidarr_requests`).toHaveLength(1);
    const off = await call(owner, 'DELETE', '/settings/lidarr/connection');
    expect(off.json()).toMatchObject({ connection: null });
    const [stored] = await sql<Array<{ settings: Record<string, unknown> }>>`select settings from installed_modules where id = 'lidarr'`;
    expect(stored!.settings).toEqual({});
    expect(await sql`select 1 from audit_log where action = 'lidarr.disconnect'`).toHaveLength(1);
    expect((await call(owner, 'POST', `/libraries/${libraryId}/lidarr/requests`, { releaseGroupId: rgSecond })).statusCode).toBe(409);
    const removed = await call(owner, 'POST', '/settings/lidarr/remove-data');
    expect(removed.json()).toMatchObject({ enabled: false, removed: { lidarr_requests: 1 } });
    expect(await sql`select 1 from release_groups`).toHaveLength(3);
    expect(await sql`select 1 from gaps`).toHaveLength(3);
  });

  it('Test is limited per owner (10 a minute)', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await call(owner, 'POST', '/settings/lidarr/test', { url: lidarr.url, apiKey: KEY })).statusCode);
    expect(codes).toContain(429);
  });
});
