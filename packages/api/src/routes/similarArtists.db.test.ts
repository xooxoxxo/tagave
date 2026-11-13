/**
 * Similar artists (the similar-artists module) against the real server on a
 * scratch database: the section, who may call the routes, Follow by MBID,
 * the mix, and the plug/unplug round trip (Module Composition Principle
 * rule 5).
 *
 *   on             on from the start; opening an artist with no list queues
 *                  one fetch and says pending; the library's artists come
 *                  first with their pictures, the rest after with Listen
 *                  elsewhere links when that module is on
 *   follow         an artist with no row gets one by MBID and is followed;
 *                  its details and discography are queued
 *   off            the section answers { available: false }, nothing is queued
 *   delete data    exactly the module's rows go, the core is as before
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import postgres from 'postgres';
import { getTableColumns } from 'drizzle-orm';
import { SIMILAR_ARTISTS_TABLES, similarArtistChecks, similarArtists, syncInstalledModules } from '@tagave/db';
import { ledgerEntries } from '@tagave/core/facets';
import type { AuthHandle } from '@tagave/auth';

const sent: Array<{ name: string; data: unknown; opts: { singletonKey?: string } }> = [];
vi.mock('../boss.js', () => ({ getBoss: async () => ({ send: async (name: string, data: unknown, opts: { singletonKey?: string }) => { sent.push({ name, data, opts }); return 'job'; } }) }));

const { registerApiRoutes } = await import('../app.js');
const { initAuth } = await import('../middleware/auth.js');
const { TEST_PUBLIC_URL, createScratchDb, migrateAll, testAuth } = await import('../testkit/authApp.js');
const { createTestUser } = await import('../testkit/users.js');
const { initDb } = await import('../db.js');
type TestUser = Awaited<ReturnType<typeof createTestUser>>;

const adminUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!adminUrl)('similar artists: the section, follow, the module switch, plug in and out (integration)', () => {
  let admin: postgres.Sql;
  let db: { url: string; name: string };
  let handle: AuthHandle;
  let sql: postgres.Sql;
  let app: FastifyInstance;
  let owner: TestUser;
  let anna: TestUser;
  let libraryId: string;
  const artistId = randomUUID();
  const artistMbid = randomUUID();
  const ownedId = randomUUID();
  const ownedMbid = randomUUID();
  const knownId = randomUUID();
  const knownMbid = randomUUID();
  const strangerMbid = randomUUID();
  const rgOwned = randomUUID();
  const albumId = randomUUID();
  const trackIds = [randomUUID(), randomUUID()];

  const as = (u: TestUser) => ({ cookie: u.cookie, origin: TEST_PUBLIC_URL });
  const get = (u: TestUser, url: string) => app.inject({ method: 'GET', url, headers: { cookie: u.cookie } });
  const similar = (u: TestUser, id = artistId) => get(u, `/api/v1/libraries/${libraryId}/artists/${id}/similar`);
  const turn = (u: TestUser, enabled: boolean) => app.inject({ method: 'PUT', url: '/api/v1/settings/similar-artists', headers: as(u), payload: { enabled } });

  const coreSnapshot = async () => ({
    artists: await sql`select * from artists order by id`,
    follows: await sql`select library_id, artist_id from followed_artists order by artist_id`,
    albums: await sql`select id, release_group_id, title_guess from local_albums order by id`,
    rga: await sql`select * from release_group_artists order by release_group_id, position`,
  });

  beforeAll(async () => {
    admin = postgres(adminUrl!, { max: 1, onnotice: () => undefined });
    db = await createScratchDb(adminUrl!, admin);
    await migrateAll(db.url);
    await initDb(db.url);
    handle = testAuth(db.url);
    initAuth(handle);
    sql = postgres(db.url, { max: 2, onnotice: () => undefined });
    await syncInstalledModules(sql, ledgerEntries());
    owner = await createTestUser(handle, { role: 'owner' });
    anna = await createTestUser(handle, { role: 'listener' });
    const [lib] = await sql<Array<{ id: string }>>`insert into libraries (owner_user_id, name, settings) values (${owner.userId}, 'Music', '{"contactString":"owner@example.com"}'::jsonb) returning id::text as id`;
    libraryId = lib!.id;
    await sql`insert into artists (id, mbid, name) values (${artistId}, ${artistMbid}, 'Radiohead'), (${ownedId}, ${ownedMbid}, 'Muse'), (${knownId}, ${knownMbid}, 'Nirvana')`;
    await sql`insert into release_groups (id, mbid, title) values (${rgOwned}, ${randomUUID()}, 'Absolution')`;
    await sql`insert into release_group_artists (release_group_id, artist_id, position) values (${rgOwned}, ${ownedId}, 0)`;
    await sql`insert into local_albums (id, library_id, cluster_key, title_guess, artist_guess, state, release_group_id)
              values (${albumId}, ${libraryId}, ${`ck-${albumId}`}, 'Absolution', 'Muse', 'matched', ${rgOwned})`;
    const rootId = randomUUID();
    await sql`insert into scan_roots (id, library_id, path, display_name, validation_status) values (${rootId}, ${libraryId}, '/nowhere', 'similar', 'ok')`;
    for (const [i, t] of trackIds.entries()) {
      const fileId = randomUUID();
      await sql`insert into files (id, library_id, scan_root_id, rel_path, handler, size_bytes, mtime, status)
                values (${fileId}, ${libraryId}, ${rootId}, ${`Muse/${i}.flac`}, 'audio', 10, 1, 'present')`;
      await sql`insert into local_tracks (id, local_album_id, audio_file_id, track_no, title_guess) values (${t}, ${albumId}, ${fileId}, ${i + 1}, ${`T${i}`})`;
    }
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

  it('the drizzle schema has every column 0084 made', async () => {
    const tables = { similar_artists: similarArtists, similar_artist_checks: similarArtistChecks };
    expect(Object.keys(tables).sort()).toEqual([...SIMILAR_ARTISTS_TABLES].sort());
    for (const [name, table] of Object.entries(tables)) {
      const inDb = (await sql<Array<{ c: string }>>`select column_name as c from information_schema.columns where table_name = ${name}`).map((r) => r.c).sort();
      expect(Object.values(getTableColumns(table)).map((c) => c.name).sort(), name).toEqual(inDb);
    }
  });

  it('on from the start: no list yet queues one fetch and says pending', async () => {
    const facets = (await get(anna, '/api/v1/facets')).json();
    expect(facets.modules.find((m: { id: string }) => m.id === 'similar-artists')).toMatchObject({ enabled: true, builtIn: false });
    expect((await similar(anna)).json()).toEqual({ available: true, pending: true, inLibrary: [], elsewhere: [], primary: null });
    expect(sent).toEqual([{ name: 'similarArtists.fetch', data: { artistId }, opts: expect.objectContaining({ singletonKey: `similar:${artistId}` }) }]);
    // an artist without an MBID: nothing to ask by
    const noMbid = randomUUID();
    await sql`insert into artists (id, name) values (${noMbid}, 'Tags Only')`;
    sent.length = 0;
    expect((await similar(anna, noMbid)).json()).toEqual({ available: true, pending: false, inLibrary: [], elsewhere: [], primary: null });
    expect(sent).toEqual([]);
    await sql`delete from artists where id = ${noMbid}`;
    // signed out: nothing
    expect((await app.inject({ method: 'GET', url: `/api/v1/libraries/${libraryId}/artists/${artistId}/similar` })).statusCode).toBe(401);
  });

  it('the library’s artists first (picture, albums), then the rest dimmed; a recent list queues nothing', async () => {
    await sql`insert into similar_artists (artist_id, position, similar_mbid, name, comment, score, sources) values
      (${artistId}, 0, ${knownMbid}, 'Nirvana', 'US grunge band', 1, '{listenbrainz}'),
      (${artistId}, 1, ${strangerMbid}, 'Stranger', 'UK band', 0.9, '{listenbrainz}'),
      (${artistId}, 2, ${ownedMbid}, 'Muse', 'UK rock band', 0.8, '{lastfm,listenbrainz}'),
      (${artistId}, 3, null, 'No Id', null, 0.2, '{lastfm}')`;
    await sql`insert into similar_artist_checks (artist_id, sources, found) values (${artistId}, '{lastfm,listenbrainz}', 4)`;
    sent.length = 0;
    const res = (await similar(anna)).json();
    expect(res.pending).toBe(false);
    expect(sent).toEqual([]);
    expect(res.inLibrary).toEqual([{ artistId: ownedId, name: 'Muse', coverAlbumIds: [], albums: 1 }]);
    expect(res.elsewhere).toEqual([
      { mbid: knownMbid, name: 'Nirvana', comment: 'US grunge band', artistId: knownId, followed: false, listen: [] },
      { mbid: strangerMbid, name: 'Stranger', comment: 'UK band', artistId: null, followed: false, listen: [] },
      { mbid: null, name: 'No Id', comment: null, artistId: null, followed: false, listen: [] },
    ]);
    // a week old: fetched again, the list shows meanwhile
    await sql`update similar_artist_checks set fetched_at = now() - interval '8 days' where artist_id = ${artistId}`;
    const again = (await similar(anna)).json();
    expect(again.pending).toBe(false);
    expect(again.elsewhere).toHaveLength(3);
    expect(sent.map((s) => s.name)).toEqual(['similarArtists.fetch']);
    await sql`update similar_artist_checks set fetched_at = now() where artist_id = ${artistId}`;
  });

  it('with Listen elsewhere on: the artist’s page when known, else a search by name', async () => {
    await sql`update installed_modules set enabled = true where id = 'listen-links'`;
    await sql`insert into listen_prefs (user_id, platforms, primary_platform) values (${anna.userId}, '{qobuz,spotify}', 'spotify')`;
    await sql`insert into listen_artist_links (artist_id, platform, url, source) values (${knownId}, 'qobuz', 'https://play.qobuz.com/artist/9', 'mb-artist')`;
    const res = (await similar(anna)).json();
    expect(res.primary).toBe('spotify');
    expect(res.elsewhere[0].listen).toEqual([
      { platform: 'qobuz', name: 'Qobuz', url: 'https://play.qobuz.com/artist/9', kind: 'artist' },
      { platform: 'spotify', name: 'Spotify', url: 'https://open.spotify.com/search/Nirvana', kind: 'search' },
    ]);
    expect(res.elsewhere[1].listen.map((l: { kind: string }) => l.kind)).toEqual(['search', 'search']);
    await sql`delete from listen_artist_links where artist_id = ${knownId}`;
    await sql`delete from listen_prefs where user_id = ${anna.userId}`;
    await sql`update installed_modules set enabled = false where id = 'listen-links'`;
  });

  it('the mix: the artist’s tracks in this library, shuffled', async () => {
    const res = (await get(anna, `/api/v1/libraries/${libraryId}/artists/${ownedId}/mix`)).json();
    expect(res.name).toBe('Muse');
    expect([...res.trackIds].sort()).toEqual([...trackIds].sort());
    expect((await get(anna, `/api/v1/libraries/${libraryId}/artists/${knownId}/mix`)).json().trackIds).toEqual([]);
  });

  it('Follow by MBID: a listener may not; the owner makes the row, follows it, queues its details and discography', async () => {
    const follow = (u: TestUser, payload: object) => app.inject({ method: 'POST', url: `/api/v1/libraries/${libraryId}/similar-artists/follow`, headers: as(u), payload });
    expect((await follow(anna, { mbid: strangerMbid, name: 'Stranger' })).statusCode).toBe(403);
    expect((await follow(owner, { mbid: 'nope', name: 'Stranger' })).statusCode).toBe(400);
    sent.length = 0;
    const res = await follow(owner, { mbid: strangerMbid, name: 'Stranger' });
    expect(res.statusCode).toBe(200);
    const { artistId: newId } = res.json();
    expect((await sql`select mbid, name from artists where id = ${newId}`)[0]).toEqual({ mbid: strangerMbid, name: 'Stranger' });
    expect(await sql`select 1 from followed_artists where library_id = ${libraryId} and artist_id = ${newId}`).toHaveLength(1);
    expect(sent.map((s) => s.name)).toEqual(['artists.enrich', 'artist.refresh']);
    // twice: the same row, one follow
    expect((await follow(owner, { mbid: strangerMbid, name: 'Stranger' })).json().artistId).toBe(newId);
    expect(await sql`select 1 from followed_artists where artist_id = ${newId}`).toHaveLength(1);
    // the section now links to it and says followed
    const stranger = (await similar(anna)).json().elsewhere.find((e: { mbid: string | null }) => e.mbid === strangerMbid);
    expect(stranger).toMatchObject({ artistId: newId, followed: true });
  });

  it('only the owner switches it; off, the section hides and nothing is queued; the rows stay', async () => {
    expect((await turn(anna, false)).statusCode).toBe(403);
    expect((await get(anna, '/api/v1/settings/similar-artists')).statusCode).toBe(403);
    expect((await turn(owner, false)).json()).toEqual({ enabled: false, artists: 1, similar: 4, lastfm: false });
    sent.length = 0;
    expect((await similar(anna)).json()).toEqual({ available: false, pending: false, inLibrary: [], elsewhere: [], primary: null });
    expect(sent).toEqual([]);
    for (const t of SIMILAR_ARTISTS_TABLES) expect((await sql`select count(*)::int as n from ${sql(t)}`)[0]!.n, t).toBeGreaterThan(0);
    expect((await turn(owner, true)).statusCode).toBe(200);
  });

  it('plugged out: "delete its data" removes exactly its rows, the core is as it was, and nothing in the core points at it', async () => {
    const before = await coreSnapshot();
    const res = await app.inject({ method: 'POST', url: '/api/v1/settings/similar-artists/remove-data', headers: as(owner) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ enabled: false, artists: 0, similar: 0, removed: { similar_artists: 4, similar_artist_checks: 1 } });
    expect(await coreSnapshot()).toEqual(before);
    const fks = await sql<Array<{ from: string; to: string; rule: string }>>`
      select c.conrelid::regclass::text as from, c.confrelid::regclass::text as to, c.confdeltype as rule
        from pg_constraint c where c.contype = 'f' and (c.conrelid::regclass::text like 'similar\\_%' or c.confrelid::regclass::text like 'similar\\_%')`;
    expect(fks.length).toBe(2);
    for (const fk of fks) {
      expect(fk.from.startsWith('similar_')).toBe(true);
      expect(fk.to).toBe('artists');
      expect(fk.rule).toBe('c');
    }
  });
});
