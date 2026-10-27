/**
 * Playlists (the playlists module, 0056) against the real server on scratch
 * databases: each person's own lists, adding tracks and albums, reorder,
 * rename, delete; the export file (no file paths) imported into a second,
 * fresh install and matched again (recording MBID, release MBID with disc
 * and track, names and length; the rest kept as Missing); M3U8 and XSPF;
 * the module switch; and the plug/unplug round trip (Module Composition
 * Principle rules 5 and 6).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import postgres from 'postgres';
import { getTableColumns } from 'drizzle-orm';
import { PLAYLISTS_TABLES, playlistItems, playlists } from '@tagave/db';
import { MODULE_DATA, PurgeRefused, purgeModuleData } from '@tagave/doctor';
import type { AuthHandle } from '@tagave/auth';

vi.mock('../boss.js', () => ({ getBoss: async () => ({ send: async () => 'job' }) }));

const { registerApiRoutes } = await import('../app.js');
const { initAuth } = await import('../middleware/auth.js');
const { TEST_PUBLIC_URL, createScratchDb, migrateAll, testAuth } = await import('../testkit/authApp.js');
const { createTestUser } = await import('../testkit/users.js');
const { initDb } = await import('../db.js');
type TestUser = Awaited<ReturnType<typeof createTestUser>>;

const adminUrl = process.env.TEST_DATABASE_URL;

interface Install {
  db: { url: string; name: string };
  sql: postgres.Sql;
  handle: AuthHandle;
  app: FastifyInstance;
  libraryId: string;
  rootId: string;
}

/** A library: two albums. Album A identified (release and recording MBIDs); album B only tagged. */
const REL_A = randomUUID();
const REC = { so: randomUUID(), blue: randomUUID() };

async function seed(i: Install, owner: TestUser, opts: { mbids: boolean; titles?: Record<string, string> }) {
  const { sql, libraryId, rootId } = i;
  const ids: Record<string, string> = {};
  const albumA = randomUUID();
  const albumB = randomUUID();
  await sql`insert into local_albums (id, library_id, cluster_key, title_guess, artist_guess, state, embedded_mbid)
            values (${albumA}, ${libraryId}, ${`ck-${albumA}`}, 'Kind of Blue', 'Miles Davis', 'matched', ${opts.mbids ? REL_A : null}),
                   (${albumB}, ${libraryId}, ${`ck-${albumB}`}, 'Time Out', 'The Dave Brubeck Quartet', 'matched', null)`;
  const track = async (key: string, albumId: string, no: number, title: string, artist: string, ms: number, recMbid?: string) => {
    const fileId = randomUUID();
    const id = randomUUID();
    let recId: string | null = null;
    if (recMbid && opts.mbids) {
      recId = randomUUID();
      await sql`insert into recordings (id, mbid, title, length_ms) values (${recId}, ${recMbid}, ${title}, ${ms})`;
    }
    await sql`insert into files (id, library_id, scan_root_id, rel_path, container, codec, lossless, duration_ms, status, handler)
      values (${fileId}, ${libraryId}, ${rootId}, ${`${artist}/${albumId === albumA ? 'Kind of Blue' : 'Time Out'}/0${no} ${title}.flac`}, 'flac', 'FLAC', true, ${ms}, 'present', 'audio')`;
    await sql`insert into local_tracks (id, local_album_id, audio_file_id, disc_no, track_no, title_guess, artist_guess, duration_ms, origin, recording_id)
      values (${id}, ${albumId}, ${fileId}, 1, ${no}, ${opts.titles?.[key] ?? title}, ${artist}, ${ms}, 'file', ${recId})`;
    ids[key] = id;
  };
  await track('so', albumA, 1, 'So What', 'Miles Davis', 562_000, REC.so);
  await track('freddie', albumA, 2, 'Freddie Freeloader', 'Miles Davis', 586_000);
  await track('blue', albumA, 3, 'Blue in Green', 'Miles Davis', 337_000, REC.blue);
  await track('rondo', albumB, 1, 'Blue Rondo à la Turk', 'The Dave Brubeck Quartet', 404_000);
  await track('five', albumB, 3, 'Take Five', 'The Dave Brubeck Quartet', 324_000);
  void owner;
  return { ids, albumA, albumB };
}

async function install(): Promise<Install & { owner: TestUser }> {
  const admin = postgres(adminUrl!, { max: 1, onnotice: () => undefined });
  const db = await createScratchDb(adminUrl!, admin);
  await admin.end({ timeout: 2 });
  await migrateAll(db.url);
  await initDb(db.url);
  const handle = testAuth(db.url);
  initAuth(handle);
  const sql = postgres(db.url, { max: 2, onnotice: () => undefined });
  const owner = await createTestUser(handle, { role: 'owner' });
  const [lib] = await sql<Array<{ id: string }>>`insert into libraries (owner_user_id, name, settings) values (${owner.userId}, 'Music', '{}'::jsonb) returning id::text as id`;
  const rootId = randomUUID();
  await sql`insert into scan_roots (id, library_id, path, display_name, validation_status) values (${rootId}, ${lib!.id}, '/mnt/music', 'Music', 'ok')`;
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);
  await registerApiRoutes(app, { backupService: { dir: '/nonexistent' } as never });
  await app.ready();
  return { db, sql, handle, app, libraryId: lib!.id, rootId, owner };
}

async function teardown(i: Install | undefined) {
  if (!i) return;
  await i.app.close();
  await i.handle.close();
  await i.sql.end({ timeout: 2 });
  const admin = postgres(adminUrl!, { max: 1, onnotice: () => undefined });
  await admin.unsafe(`drop database if exists ${i.db.name} with (force)`).catch(() => undefined);
  await admin.end({ timeout: 2 });
}

describe.skipIf(!adminUrl)('playlists: lists, export and import, the module switch, plug in and out (integration)', () => {
  let one: Install & { owner: TestUser };
  let anna: TestUser;
  let ben: TestUser;
  let lib: Awaited<ReturnType<typeof seed>>;
  let exported = '';

  const as = (u: TestUser) => ({ cookie: u.cookie, origin: TEST_PUBLIC_URL });
  const call = (u: TestUser, method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT', url: string, payload?: object, app = one.app) =>
    app.inject({ method, url: `/api/v1${url}`, headers: as(u), ...(payload ? { payload } : {}) });

  /** Every core row of the install, as text: what plugging the module in and out must leave alone. */
  const coreSnapshot = async (sql: postgres.Sql) => ({
    users: await sql`select id, email, role from users order by id`,
    libraries: await sql`select id, name, (settings #- '{modules,playlists}') as settings from libraries order by id`,
    albums: await sql`select * from local_albums order by id`,
    tracks: await sql`select * from local_tracks order by id`,
    files: await sql`select * from files order by id`,
    recordings: await sql`select * from recordings order by id`,
  });

  beforeAll(async () => {
    one = await install();
    anna = await createTestUser(one.handle, { role: 'listener' });
    ben = await createTestUser(one.handle, { role: 'listener' });
    lib = await seed(one, one.owner, { mbids: true });
  });

  afterAll(async () => {
    await teardown(one);
  });

  it('the drizzle schema has every column 0056 made', async () => {
    const tables = { playlists, playlist_items: playlistItems };
    expect(Object.keys(tables).sort()).toEqual([...PLAYLISTS_TABLES].sort());
    for (const [name, table] of Object.entries(tables)) {
      const inDb = (await one.sql<Array<{ c: string }>>`select column_name as c from information_schema.columns where table_name = ${name}`).map((r) => r.c).sort();
      expect(Object.values(getTableColumns(table)).map((c) => c.name).sort(), name).toEqual(inDb);
    }
  });

  it('on by default, empty; signed out gets nothing', async () => {
    expect((await call(anna, 'GET', '/me/playlists')).json()).toEqual({ playlists: [] });
    expect((await one.app.inject({ method: 'GET', url: '/api/v1/me/playlists' })).statusCode).toBe(401);
    const facets = (await call(anna, 'GET', '/facets')).json();
    expect(facets.modules.find((m: { id: string }) => m.id === 'playlists')).toMatchObject({ enabled: true, builtIn: false });
  });

  it('a person makes a list, adds tracks and an album, reorders, renames, removes one', async () => {
    const created = await call(anna, 'POST', '/me/playlists', { name: '  Late night ', trackIds: [lib.ids['blue']!, lib.ids['five']!] });
    expect(created.statusCode).toBe(201);
    const p = created.json();
    expect(p).toMatchObject({ name: 'Late night', tracks: 2 });
    expect(p.items.map((i: any) => i.title)).toEqual(['Blue in Green', 'Take Five']);
    expect((await call(anna, 'POST', '/me/playlists', { name: '' })).statusCode).toBe(400);
    expect((await call(anna, 'POST', '/me/playlists', { name: 'x' }, one.app)).statusCode).toBe(201);
    // an album at the end, in its order
    const withAlbum = (await call(anna, 'POST', `/me/playlists/${p.id}/items`, { albumId: lib.albumA })).json();
    expect(withAlbum.items.map((i: any) => i.title)).toEqual(['Blue in Green', 'Take Five', 'So What', 'Freddie Freeloader', 'Blue in Green']);
    expect(withAlbum.durationMs).toBe(337_000 + 324_000 + 562_000 + 586_000 + 337_000);
    // reorder: every item once
    const order = [...withAlbum.items].reverse().map((i: any) => i.id);
    expect((await call(anna, 'PATCH', `/me/playlists/${p.id}`, { order: order.slice(1) })).statusCode).toBe(409);
    const reordered = (await call(anna, 'PATCH', `/me/playlists/${p.id}`, { order, name: 'Late night, reversed' })).json();
    expect(reordered.name).toBe('Late night, reversed');
    expect(reordered.items.map((i: any) => i.title)).toEqual(['Blue in Green', 'Freddie Freeloader', 'So What', 'Take Five', 'Blue in Green']);
    const removed = (await call(anna, 'DELETE', `/me/playlists/${p.id}/items/${reordered.items[0].id}`)).json();
    expect(removed.items.map((i: any) => i.title)).toEqual(['Freddie Freeloader', 'So What', 'Take Five', 'Blue in Green']);
    expect((await call(anna, 'GET', '/me/playlists')).json().playlists.map((x: any) => x.name).sort()).toEqual(['Late night, reversed', 'x']);
  });

  it('lists are private: another person can neither see nor change them', async () => {
    const [p] = (await call(anna, 'GET', '/me/playlists')).json().playlists;
    expect((await call(ben, 'GET', '/me/playlists')).json()).toEqual({ playlists: [] });
    expect((await call(ben, 'GET', `/me/playlists/${p.id}`)).statusCode).toBe(404);
    expect((await call(ben, 'PATCH', `/me/playlists/${p.id}`, { name: 'mine' })).statusCode).toBe(404);
    expect((await call(ben, 'POST', `/me/playlists/${p.id}/items`, { trackIds: [lib.ids['so']!] })).statusCode).toBe(404);
    expect((await call(ben, 'DELETE', `/me/playlists/${p.id}`)).statusCode).toBe(404);
    expect((await call(ben, 'GET', `/me/playlists/${p.id}/export`)).statusCode).toBe(404);
    // a request from another site is refused
    expect((await one.app.inject({ method: 'POST', url: '/api/v1/me/playlists', headers: { cookie: anna.cookie, origin: 'http://evil.example' }, payload: { name: 'x' } })).statusCode).toBe(403);
    // only the owner sees the module row
    expect((await call(anna, 'GET', '/settings/playlists')).statusCode).toBe(403);
  });

  it('a track that leaves the library stays in the list, Missing, with its name', async () => {
    const extra = randomUUID();
    const fileId = randomUUID();
    await one.sql`insert into files (id, library_id, scan_root_id, rel_path, container, status, handler) values (${fileId}, ${one.libraryId}, ${one.rootId}, 'gone.flac', 'flac', 'present', 'audio')`;
    await one.sql`insert into local_tracks (id, local_album_id, audio_file_id, track_no, title_guess, artist_guess, duration_ms, origin) values (${extra}, ${lib.albumB}, ${fileId}, 9, 'Gone Soon', 'Someone', 100000, 'file')`;
    const [p] = (await call(anna, 'GET', '/me/playlists')).json().playlists.filter((x: any) => x.name === 'x');
    await call(anna, 'POST', `/me/playlists/${p.id}/items`, { trackIds: [extra, lib.ids['so']!] });
    await one.sql`delete from local_tracks where id = ${extra}`;
    const view = (await call(anna, 'GET', `/me/playlists/${p.id}`)).json();
    expect(view.items.map((i: any) => [i.title, i.localTrackId === null])).toEqual([['Gone Soon', true], ['So What', false]]);
  });

  it('exports without file paths, in the documented format', async () => {
    const res = await call(anna, 'GET', '/me/playlists/export');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toContain('.tagave-playlist.json');
    exported = res.body;
    const file = JSON.parse(exported);
    expect(file).toMatchObject({ format: 'tagave-playlist', version: 1 });
    expect(file.playlists).toHaveLength(2);
    expect(exported).not.toMatch(/\.flac|\/mnt\/music|rel_?path|location/i);
    const late = file.playlists.find((p: any) => p.name === 'Late night, reversed');
    expect(late.items[1]).toEqual({ recordingMbid: REC.so, releaseMbid: REL_A, discNo: 1, trackNo: 1, title: 'So What', artist: 'Miles Davis', album: 'Kind of Blue', durationMs: 562_000 });
    expect(late.owner).toBeUndefined();
    // one list alone
    const lateId = (await call(anna, 'GET', '/me/playlists')).json().playlists.find((p: any) => p.name === 'Late night, reversed').id;
    const single = JSON.parse((await call(anna, 'GET', `/me/playlists/${lateId}/export`)).body);
    expect(single.playlists.map((p: any) => p.name)).toEqual(['Late night, reversed']);
  });

  it('imports into a second, fresh install: matched by MBIDs, disc and track, names and length; the rest Missing', async () => {
    const two = await install();
    try {
      const carla = await createTestUser(two.handle, { role: 'listener' });
      // the same music, but on this install only Freddie Freeloader is identified by its album's MBID, and
      // "Take Five" has another spelling: names and length still find it
      await seed(two, two.owner, { mbids: true, titles: { five: 'TAKE FIVE!' } });
      const res = await call(carla, 'POST', '/me/playlists/import', { content: exported, fileName: 'mine.tagave-playlist.json' }, two.app);
      expect(res.statusCode, res.body).toBe(200);
      const result = res.json();
      const late = result.playlists.find((p: any) => p.name === 'Late night, reversed');
      expect(late).toMatchObject({ tracks: 4, matched: 4, missing: 0 });
      const other = result.playlists.find((p: any) => p.name === 'x');
      expect(other).toMatchObject({ tracks: 2, matched: 1, missing: 1 });
      const view = (await call(carla, 'GET', `/me/playlists/${late.id}`, undefined, two.app)).json();
      expect(view.items.map((i: any) => i.title)).toEqual(['Freddie Freeloader', 'So What', 'Take Five', 'Blue in Green']);
      expect(view.items.every((i: any) => i.localTrackId)).toBe(true);
      const missing = (await call(carla, 'GET', `/me/playlists/${other.id}`, undefined, two.app)).json();
      expect(missing.items.map((i: any) => [i.title, i.localTrackId === null])).toEqual([['Gone Soon', true], ['So What', false]]);
      // what it matched with: the recording MBID first, the album's MBID with disc and track next
      const so = await two.sql`select i.local_track_id from playlist_items i join playlists p on p.id = i.playlist_id where p.id = ${late.id} and i.title = 'So What'`;
      const [soTrack] = await two.sql`select lt.id from local_tracks lt join recordings r on r.id = lt.recording_id where r.mbid = ${REC.so}`;
      expect(so[0]!.local_track_id).toBe(soTrack!.id);

      // M3U8 and XSPF
      const m3u = '#EXTM3U\n#EXTINF:404,The Dave Brubeck Quartet - Blue Rondo a la Turk\n/Volumes/Music/whatever.flac\n#EXTINF:1,Nobody - Nothing\nnothing.mp3\n/elsewhere/Miles Davis/Kind of Blue/03 Blue in Green.flac\n';
      const fromM3u = (await call(carla, 'POST', '/me/playlists/import', { content: m3u, fileName: 'Road trip.m3u8' }, two.app)).json();
      expect(fromM3u.playlists).toEqual([expect.objectContaining({ name: 'Road trip', tracks: 3, matched: 2, missing: 1 })]);
      const xspf = `<?xml version="1.0"?><playlist version="1" xmlns="http://xspf.org/ns/0/"><title>Ballads</title><trackList>
        <track><title>Blue in Green</title><creator>Miles Davis</creator><identifier>https://musicbrainz.org/recording/${REC.blue}</identifier></track></trackList></playlist>`;
      expect((await call(carla, 'POST', '/me/playlists/import', { content: xspf }, two.app)).json().playlists).toEqual([expect.objectContaining({ name: 'Ballads', matched: 1, missing: 0 })]);
      expect((await call(carla, 'POST', '/me/playlists/import', { content: '{"format":"tagave-playlist","version":2,"playlists":[]}' }, two.app)).statusCode).toBe(400);
    } finally {
      await teardown(two);
      // the app's database and auth are process-wide: back to the first install
      await initDb(one.db.url);
      initAuth(one.handle);
    }
  });

  it('turned off: the routes refuse, the lists stay; on again, they are back', async () => {
    const before = await one.sql`select * from playlist_items order by id`;
    expect((await call(anna, 'PUT', '/settings/playlists', { enabled: false })).statusCode).toBe(403);
    expect((await call(one.owner, 'PUT', '/settings/playlists', { enabled: false })).json()).toMatchObject({ enabled: false, playlists: 2, people: 1 });
    expect((await call(anna, 'GET', '/me/playlists')).statusCode).toBe(409);
    expect((await call(anna, 'GET', '/facets')).json().modules.find((m: { id: string }) => m.id === 'playlists').enabled).toBe(false);
    expect(await one.sql`select * from playlist_items order by id`).toEqual(before);
    await expect(purgeModuleData(one.sql as never, 'playlists', { env: {} })).resolves.toBeDefined();
    // the purge above deleted them (off, so it may): put them back from the export for the next step
    expect((await call(one.owner, 'PUT', '/settings/playlists', { enabled: true })).statusCode).toBe(200);
    expect((await call(anna, 'POST', '/me/playlists/import', { content: exported })).statusCode).toBe(200);
  });

  it('the owner’s export first: everyone’s lists in one file, each with its owner', async () => {
    const res = await call(one.owner, 'GET', '/settings/playlists/export');
    expect(res.statusCode).toBe(200);
    const file = JSON.parse(res.body);
    expect(file.playlists.map((p: any) => p.owner)).toEqual(['listener person', 'listener person']);
    expect((await call(anna, 'GET', '/settings/playlists/export')).statusCode).toBe(403);
  });

  it('plugged out: "delete its data" removes exactly its rows, the core is as it was; the purge refuses while it is on', async () => {
    await expect(purgeModuleData(one.sql as never, 'playlists', { env: {} })).rejects.toBeInstanceOf(PurgeRefused);
    const before = await coreSnapshot(one.sql);
    const res = await call(one.owner, 'POST', '/settings/playlists/remove-data');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ enabled: false, playlists: 0, removed: { playlists: 2 } });
    expect(res.json().removed.playlist_items).toBeGreaterThan(0);
    for (const t of PLAYLISTS_TABLES) expect((await one.sql`select count(*)::int as n from ${one.sql(t)}`)[0]!.n, t).toBe(0);
    expect(await coreSnapshot(one.sql)).toEqual(before);
    // the doctor's purge: the same tables, and nothing more to delete
    expect([...MODULE_DATA['playlists']!.tables]).toEqual([...PLAYLISTS_TABLES]);
    const again = await purgeModuleData(one.sql as never, 'playlists', { env: {} });
    expect(Object.values(again.deleted).every((n) => n === 0)).toBe(true);
    // nothing in the core points at a playlist table
    const refs = await one.sql`select conrelid::regclass::text as t from pg_constraint where contype = 'f' and confrelid::regclass::text in ('playlists', 'playlist_items')`;
    expect(refs.map((r) => r.t)).toEqual(['playlist_items']);
    // on again: it starts empty and works
    await call(one.owner, 'PUT', '/settings/playlists', { enabled: true });
    expect((await call(anna, 'POST', '/me/playlists', { name: 'Again', trackIds: [lib.ids['so']!] })).statusCode).toBe(201);
  });
});
