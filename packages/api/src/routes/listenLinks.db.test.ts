/**
 * Listen elsewhere (the listen-links module) against the real server on a
 * scratch database: the routes, who may call them, and the plug/unplug
 * round trip (Module Composition Principle rule 5).
 *
 *   off            every link route answers { available: false }, nothing is queued
 *   on             each person sees their own platforms, in their order: the
 *                  album's page, else the artist's, else a search; opening an
 *                  album or an artist queues one lookup
 *   delete data    exactly the module's rows go, the core is as before, a
 *                  second removal deletes nothing; no core table references
 *                  a listen_ table
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import postgres from 'postgres';
import { getTableColumns } from 'drizzle-orm';
import { LISTEN_LINKS_TABLES, listenAlbumChecks, listenArtistChecks, listenArtistLinks, listenLinks, listenPrefs } from '@tagave/db';
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

describe.skipIf(!adminUrl)('listen elsewhere: links, platforms, the module switch, plug in and out (integration)', () => {
  let admin: postgres.Sql;
  let db: { url: string; name: string };
  let handle: AuthHandle;
  let sql: postgres.Sql;
  let app: FastifyInstance;
  let owner: TestUser;
  let anna: TestUser;
  let ben: TestUser;
  let libraryId: string;
  const artistId = randomUUID();
  const rgOwned = randomUUID();
  const rgMissing = randomUUID();
  const rgSkipped = randomUUID();
  const albumId = randomUUID();

  const as = (u: TestUser) => ({ cookie: u.cookie, origin: TEST_PUBLIC_URL });
  const get = (u: TestUser, url: string) => app.inject({ method: 'GET', url, headers: { cookie: u.cookie } });
  const albumLinks = (u: TestUser, rg = rgOwned) => get(u, `/api/v1/libraries/${libraryId}/release-groups/${rg}/listen-links`);
  const artistLinks = (u: TestUser) => get(u, `/api/v1/libraries/${libraryId}/artists/${artistId}/listen-links`);
  const pick = (u: TestUser, platforms: string[]) => app.inject({ method: 'PUT', url: '/api/v1/me/listen-links', headers: as(u), payload: { platforms } });
  const turn = (u: TestUser, enabled: boolean) => app.inject({ method: 'PUT', url: '/api/v1/settings/listen-links', headers: as(u), payload: { enabled } });

  /** Every core row this suite made, as text: what plugging the module in and out must leave alone. */
  const coreSnapshot = async () => ({
    users: await sql`select id, email, role from users order by id`,
    libraries: await sql`select id, name, (settings #- '{modules,listen-links}') as settings from libraries order by id`,
    artists: await sql`select * from artists order by id`,
    releaseGroups: await sql`select * from release_groups order by id`,
    rga: await sql`select * from release_group_artists order by release_group_id, position`,
    gaps: await sql`select * from gaps order by id`,
    albums: await sql`select id, release_group_id, title_guess from local_albums order by id`,
  });

  beforeAll(async () => {
    admin = postgres(adminUrl!, { max: 1, onnotice: () => undefined });
    db = await createScratchDb(adminUrl!, admin);
    await migrateAll(db.url);
    await initDb(db.url);
    handle = testAuth(db.url);
    initAuth(handle);
    sql = postgres(db.url, { max: 2, onnotice: () => undefined });
    owner = await createTestUser(handle, { role: 'owner' });
    anna = await createTestUser(handle, { role: 'listener' });
    ben = await createTestUser(handle, { role: 'listener' });
    const [lib] = await sql<Array<{ id: string }>>`insert into libraries (owner_user_id, name, settings) values (${owner.userId}, 'Music', '{"contactString":"owner@example.test"}'::jsonb) returning id::text as id`;
    libraryId = lib!.id;
    await sql`insert into artists (id, mbid, name) values (${artistId}, ${randomUUID()}, 'The Plugs')`;
    await sql`insert into release_groups (id, mbid, title) values (${rgOwned}, ${randomUUID()}, 'Plugged In'), (${rgMissing}, ${randomUUID()}, 'Unplugged'), (${rgSkipped}, ${randomUUID()}, 'Skipped')`;
    await sql`insert into release_group_artists (release_group_id, artist_id, position) values (${rgOwned}, ${artistId}, 0), (${rgMissing}, ${artistId}, 0), (${rgSkipped}, ${artistId}, 0)`;
    await sql`insert into local_albums (id, library_id, cluster_key, title_guess, artist_guess, state, release_group_id)
              values (${albumId}, ${libraryId}, ${`ck-${albumId}`}, 'Plugged In', 'The Plugs', 'matched', ${rgOwned})`;
    await sql`insert into gaps (library_id, kind, subject_type, subject_id) values (${libraryId}, 'missing_album', 'release_group', ${rgMissing})`;
    await sql`insert into gaps (library_id, kind, subject_type, subject_id, state, dismiss_reason) values (${libraryId}, 'missing_album', 'release_group', ${rgSkipped}, 'dismissed', 'not_interested')`;
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

  it('the drizzle schema has every column 0054 made', async () => {
    const tables = { listen_links: listenLinks, listen_artist_links: listenArtistLinks, listen_album_checks: listenAlbumChecks, listen_artist_checks: listenArtistChecks, listen_prefs: listenPrefs };
    expect(Object.keys(tables).sort()).toEqual([...LISTEN_LINKS_TABLES].sort());
    for (const [name, table] of Object.entries(tables)) {
      const inDb = (await sql<Array<{ c: string }>>`select column_name as c from information_schema.columns where table_name = ${name}`).map((r) => r.c).sort();
      expect(Object.values(getTableColumns(table)).map((c) => c.name).sort(), name).toEqual(inDb);
    }
  });

  it('off by default: nothing shows, nothing is queued, a person cannot pick', async () => {
    const before = await coreSnapshot();
    expect((await albumLinks(anna)).json()).toEqual({ available: false, links: [], pending: false });
    expect((await artistLinks(anna)).json()).toEqual({ available: false, albums: {}, pending: false });
    expect((await get(anna, '/api/v1/me/listen-links')).json()).toEqual({ available: false, platforms: [] });
    expect((await pick(anna, ['qobuz'])).statusCode).toBe(409);
    expect((await get(owner, '/api/v1/settings/listen-links')).json()).toEqual({ enabled: false, albums: 0, artists: 0, people: 0 });
    const facets = (await get(anna, '/api/v1/facets')).json();
    expect(facets.modules.find((m: { id: string }) => m.id === 'listen-links')).toMatchObject({ enabled: false, builtIn: false });
    expect(sent).toEqual([]);
    expect(await coreSnapshot()).toEqual(before);
  });

  it('only the owner turns it on; a listener may read links but not switch it', async () => {
    expect((await turn(anna, true)).statusCode).toBe(403);
    expect((await get(anna, '/api/v1/settings/listen-links')).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/v1/settings/listen-links/remove-data', headers: as(anna) })).statusCode).toBe(403);
    expect((await turn(owner, true)).json()).toMatchObject({ enabled: true });
    expect((await get(anna, '/api/v1/facets')).json().modules.find((m: { id: string }) => m.id === 'listen-links').enabled).toBe(true);
    // signed out: nothing
    expect((await app.inject({ method: 'GET', url: `/api/v1/libraries/${libraryId}/release-groups/${rgOwned}/listen-links` })).statusCode).toBe(401);
  });

  it('none picked until the person chooses; each person has their own platforms, in their order', async () => {
    expect((await albumLinks(anna)).json()).toEqual({ available: true, links: [], pending: false });
    expect(sent).toEqual([]);
    expect((await pick(anna, ['qobuz', 'qobuz'])).statusCode).toBe(400);
    expect((await pick(anna, ['napster'])).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: '/api/v1/me/listen-links', headers: { cookie: anna.cookie, origin: 'http://evil.example' }, payload: { platforms: ['qobuz'] } })).statusCode).toBe(403);
    expect((await pick(anna, ['qobuz', 'spotify', 'tidal'])).json()).toEqual({ available: true, platforms: ['qobuz', 'spotify', 'tidal'] });
    expect((await pick(ben, ['spotify'])).statusCode).toBe(200);
    expect((await get(anna, '/api/v1/me/listen-links')).json()).toEqual({ available: true, platforms: ['qobuz', 'spotify', 'tidal'] });
    expect((await get(ben, '/api/v1/me/listen-links')).json()).toEqual({ available: true, platforms: ['spotify'] });
  });

  it('an album: its own page, else the artist’s, else a search; opening it queues one lookup', async () => {
    await sql`insert into listen_links (release_group_id, platform, url, source) values (${rgOwned}, 'spotify', 'https://open.spotify.com/album/abc', 'mb-release')`;
    await sql`insert into listen_artist_links (artist_id, platform, url, source) values (${artistId}, 'qobuz', 'https://play.qobuz.com/artist/1', 'mb-artist')`;
    const res = (await albumLinks(anna)).json();
    expect(res.links).toEqual([
      { platform: 'qobuz', name: 'Qobuz', url: 'https://play.qobuz.com/artist/1', kind: 'artist' },
      { platform: 'spotify', name: 'Spotify', url: 'https://open.spotify.com/album/abc', kind: 'exact' },
      { platform: 'tidal', name: 'Tidal', url: 'https://tidal.com/search?q=The%20Plugs%20Plugged%20In', kind: 'search' },
    ]);
    expect(res.pending).toBe(true);
    expect(sent).toEqual([{ name: 'listenLinks.resolve', data: { releaseGroupId: rgOwned }, opts: expect.objectContaining({ singletonKey: `listen:rg:${rgOwned}` }) }]);
    expect((await albumLinks(ben)).json().links).toEqual([{ platform: 'spotify', name: 'Spotify', url: 'https://open.spotify.com/album/abc', kind: 'exact' }]);

    // looked up lately, for every picked platform: nothing more is queued
    sent.length = 0;
    await sql`insert into listen_album_checks (release_group_id, platforms, found) values (${rgOwned}, '{qobuz,spotify,tidal}', 1)`;
    await sql`insert into listen_artist_checks (artist_id, platforms, found) values (${artistId}, '{qobuz,spotify,tidal}', 1)`;
    expect((await albumLinks(anna)).json().pending).toBe(false);
    expect(sent).toEqual([]);
  });

  it('an artist: links for each album it is missing (not the owned or skipped ones)', async () => {
    const res = (await artistLinks(anna)).json();
    expect(Object.keys(res.albums)).toEqual([rgMissing]);
    expect(res.albums[rgMissing]).toEqual([
      { platform: 'qobuz', name: 'Qobuz', url: 'https://play.qobuz.com/artist/1', kind: 'artist' },
      { platform: 'spotify', name: 'Spotify', url: 'https://open.spotify.com/search/The%20Plugs%20Unplugged', kind: 'search' },
      { platform: 'tidal', name: 'Tidal', url: 'https://tidal.com/search?q=The%20Plugs%20Unplugged', kind: 'search' },
    ]);
    // the missing album was never looked up
    expect(res.pending).toBe(true);
    expect(sent.at(-1)).toEqual({ name: 'listenLinks.resolve', data: { artistId }, opts: expect.objectContaining({ singletonKey: `listen:artist:${artistId}` }) });
  });

  it('turned off: links hide, a person’s choice and every row stay', async () => {
    expect((await turn(owner, false)).json()).toMatchObject({ enabled: false, albums: 1, artists: 1, people: 2 });
    sent.length = 0;
    expect((await albumLinks(anna)).json()).toEqual({ available: false, links: [], pending: false });
    expect((await artistLinks(anna)).json()).toEqual({ available: false, albums: {}, pending: false });
    expect(sent).toEqual([]);
    for (const t of LISTEN_LINKS_TABLES) expect((await sql`select count(*)::int as n from ${sql(t)}`)[0]!.n, t).toBeGreaterThan(0);
    expect((await turn(owner, true)).statusCode).toBe(200);
    expect((await albumLinks(anna)).json().links).toHaveLength(3);
  });

  it('plugged out: "delete its data" removes exactly its rows, the core is as it was, and nothing in the core points at it', async () => {
    const before = await coreSnapshot();
    const res = await app.inject({ method: 'POST', url: '/api/v1/settings/listen-links/remove-data', headers: as(owner) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ enabled: false, albums: 0, artists: 0, people: 0, removed: { listen_links: 1, listen_artist_links: 1, listen_album_checks: 1, listen_artist_checks: 1, listen_prefs: 2 } });
    for (const t of LISTEN_LINKS_TABLES) expect((await sql`select count(*)::int as n from ${sql(t)}`)[0]!.n, t).toBe(0);
    expect(await coreSnapshot()).toEqual(before);
    // idempotent
    await turn(owner, true);
    const again = (await app.inject({ method: 'POST', url: '/api/v1/settings/listen-links/remove-data', headers: as(owner) })).json();
    expect(Object.values(again.removed)).toEqual([0, 0, 0, 0, 0]);
    // module tables point at the core (cascade); no core table points at a module table
    const fks = await sql<Array<{ from: string; to: string; rule: string }>>`
      select c.conrelid::regclass::text as from, c.confrelid::regclass::text as to, c.confdeltype as rule
        from pg_constraint c where c.contype = 'f' and (c.conrelid::regclass::text like 'listen\\_%' or c.confrelid::regclass::text like 'listen\\_%')`;
    expect(fks.length).toBe(5);
    for (const fk of fks) {
      expect(fk.from.startsWith('listen_'), `${fk.from} → ${fk.to}`).toBe(true);
      expect(fk.to.startsWith('listen_')).toBe(false);
      expect(fk.rule).toBe('c');
    }
    const audit = await sql`select payload from audit_log where action = 'module.remove_data'`;
    expect(audit.length).toBe(2);
  });
});
