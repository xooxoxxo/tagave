/**
 * Albums report "files offline" (vault "tagave - Offline Library Spec" §5):
 * the album list, album page, search and the artist page add `filesOffline`
 * ('all' | 'some' | null) and `offlineSince` when an enabled music folder is
 * not online, from the album's present files and their scan roots. With
 * every folder online nothing is added and no offline query runs.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';

vi.mock('../boss.js', () => ({
  getBoss: async () => ({ send: async () => 'job-id', createQueue: async () => undefined }),
}));

// The second query (albumsOffline) runs only when notOnlineRoots found a root: count its calls.
vi.mock('@tagave/db', async (importOriginal) => {
  const real = await importOriginal<typeof import('@tagave/db')>();
  return { ...real, albumsOffline: vi.fn(real.albumsOffline) };
});

describe.skipIf(!process.env.TEST_DATABASE_URL)('albums: files offline (db)', () => {
  let app: FastifyInstance;
  let client: any;
  let albumsOfflineSpy: ReturnType<typeof vi.fn>;
  const userId = randomUUID();
  const lib = randomUUID();
  const offRoot = randomUUID();
  const onRoot = randomUUID();
  const artistId = randomUUID();
  const artistName = `Robin Offline ${userId.slice(0, 8)}`;
  const album = { all: randomUUID(), some: randomUUID(), online: randomUUID() };
  const since = '2026-11-24T14:02:00.000Z';

  const get = async (url: string) => {
    const res = await app.inject({ method: 'GET', url, headers: { 'x-test-user': userId } });
    expect(res.statusCode, `${url}: ${res.body}`).toBe(200);
    return res.json();
  };
  const track = async (albumId: string, rootId: string, name: string, status = 'present') => {
    const fileId = randomUUID();
    await client`insert into files (id, library_id, scan_root_id, rel_path, handler, status)
                 values (${fileId}, ${lib}, ${rootId}, ${`${name}.flac`}, 'audio', ${status})`;
    await client`insert into local_tracks (local_album_id, audio_file_id, track_no) values (${albumId}, ${fileId}, 1)`;
  };
  const setReach = async (rootId: string, reach: string, at: string | null) => {
    await client`update scan_roots set reach = ${reach}, reach_since = ${at} where id = ${rootId}`;
  };

  beforeAll(async () => {
    const { initDb } = await import('../db.js');
    const made = await initDb(process.env.TEST_DATABASE_URL!);
    client = made.client;
    albumsOfflineSpy = (await import('@tagave/db')).albumsOffline as unknown as ReturnType<typeof vi.fn>;
    // the album page asks pg-boss for queued identify jobs: the job table as the shared-database suites stand it in
    await client`do $$ begin
      if not exists (select 1 from pg_namespace where nspname = 'pgboss') then create schema pgboss; end if;
    end $$`;
    await client`create table if not exists pgboss.job (
      id uuid, name text, state text, priority int, singleton_key text, data jsonb)`;
    await client`alter table pgboss.job add column if not exists created_on timestamptz, add column if not exists started_on timestamptz,
      add column if not exists completed_on timestamptz, add column if not exists output jsonb`;
    await client`insert into users (id, email, password_hash) values (${userId}, ${`robin-${userId}@example.com`}, 'x')`;
    await client`insert into libraries (id, name, owner_user_id, settings) values (${lib}, 'Offline', ${userId}, '{}')`;
    await client`insert into scan_roots (id, library_id, path, display_name) values
      (${offRoot}, ${lib}, ${`/mnt/music/off-${lib}`}, 'Share'), (${onRoot}, ${lib}, ${`/mnt/music/on-${lib}`}, 'Disk')`;
    await client`insert into artists (id, name) values (${artistId}, ${artistName})`;
    await client`insert into local_albums (id, library_id, cluster_key, state, title_guess, artist_guess) values
      (${album.all}, ${lib}, ${`fo:${album.all}`}, 'unidentified', 'Offline All', ${artistName}),
      (${album.some}, ${lib}, ${`fo:${album.some}`}, 'unidentified', 'Offline Some', ${artistName}),
      (${album.online}, ${lib}, ${`fo:${album.online}`}, 'unidentified', 'Offline None', ${artistName})`;
    await track(album.all, offRoot, 'all-1');
    await track(album.all, offRoot, 'all-2');
    // a missing file on the online root is not a present file: the album stays all offline
    await track(album.all, onRoot, 'all-gone', 'missing');
    await track(album.some, offRoot, 'some-1');
    await track(album.some, onRoot, 'some-2');
    await track(album.online, onRoot, 'none-1');

    const { errorHandler } = await import('../middleware/errorHandler.js');
    const { createAlbumRoutes } = await import('./albums.js');
    const { createSearchRoutes } = await import('./search.js');
    const { createArtistsRoutes } = await import('./artists.js');
    app = Fastify({ logger: false });
    await errorHandler(app);
    app.addHook('preHandler', async (request) => {
      const id = request.headers['x-test-user'];
      request.user = typeof id === 'string' ? ({ id, email: `${id}@example.com` } as any) : undefined;
    });
    await app.register(createAlbumRoutes, { prefix: '/api/v1' });
    await app.register(createSearchRoutes, { prefix: '/api/v1' });
    await app.register(createArtistsRoutes, { prefix: '/api/v1' });
    await app.ready();
  });

  beforeEach(async () => {
    albumsOfflineSpy.mockClear();
    await setReach(offRoot, 'offline', since);
    await setReach(onRoot, 'online', null);
  });

  afterAll(async () => {
    await app?.close();
    await client`delete from filter_rail_state where library_id = ${lib}`;
    await client`delete from album_filter_counts where library_id = ${lib}`;
    await client`delete from local_albums where library_id = ${lib}`;
    await client`delete from files where library_id = ${lib}`;
    await client`delete from scan_roots where library_id = ${lib}`;
    await client`delete from artists where id = ${artistId}`;
    await client`delete from libraries where id = ${lib}`;
    await client`delete from users where id = ${userId}`;
    await client?.end({ timeout: 5 });
  });

  it('an album on an offline root is all offline, with the root\'s since time', async () => {
    const list = await get(`/api/v1/libraries/${lib}/albums?limit=50`);
    const all = list.items.find((a: any) => a.id === album.all);
    expect(all).toMatchObject({ filesOffline: 'all', offlineSince: since });
    const none = list.items.find((a: any) => a.id === album.online);
    expect(none).toMatchObject({ filesOffline: null, offlineSince: null });

    const detail = await get(`/api/v1/libraries/${lib}/albums/${album.all}`);
    expect(detail).toMatchObject({ filesOffline: 'all', offlineSince: since });
    // the spy sees the routes' offline query (so its silence below means something)
    expect(albumsOfflineSpy).toHaveBeenCalledTimes(2);
  });

  it('an album with files on two roots, one offline, is some', async () => {
    const list = await get(`/api/v1/libraries/${lib}/albums?limit=50`);
    expect(list.items.find((a: any) => a.id === album.some)).toMatchObject({ filesOffline: 'some', offlineSince: since });
    const detail = await get(`/api/v1/libraries/${lib}/albums/${album.some}`);
    expect(detail).toMatchObject({ filesOffline: 'some', offlineSince: since });
  });

  it('an unmounted root counts as not online; a turned-off root does not', async () => {
    await setReach(offRoot, 'unmounted', since);
    const list = await get(`/api/v1/libraries/${lib}/albums?limit=50`);
    expect(list.items.find((a: any) => a.id === album.all)).toMatchObject({ filesOffline: 'all' });

    await client`update scan_roots set enabled = false where id = ${offRoot}`;
    try {
      albumsOfflineSpy.mockClear();
      const off = await get(`/api/v1/libraries/${lib}/albums?limit=50`);
      for (const a of off.items) expect(a).not.toHaveProperty('filesOffline');
    } finally {
      await client`update scan_roots set enabled = true where id = ${offRoot}`;
    }
  });

  it('with every root online, the list has no filesOffline key and runs no offline query', async () => {
    await setReach(offRoot, 'online', null);
    const list = await get(`/api/v1/libraries/${lib}/albums?limit=50`);
    expect(list.items).toHaveLength(3);
    for (const a of list.items) {
      expect(a).not.toHaveProperty('filesOffline');
      expect(a).not.toHaveProperty('offlineSince');
    }
    const detail = await get(`/api/v1/libraries/${lib}/albums/${album.all}`);
    expect(detail).not.toHaveProperty('filesOffline');
    const search = await get(`/api/v1/libraries/${lib}/search?q=${encodeURIComponent('Offline')}&kind=albums`);
    for (const a of search.albums) expect(a).not.toHaveProperty('filesOffline');
    const artist = await get(`/api/v1/libraries/${lib}/artists/${artistId}`);
    for (const a of artist.albums) expect(a).not.toHaveProperty('filesOffline');
    expect(albumsOfflineSpy).not.toHaveBeenCalled();
  });

  it('search and the artist page carry the same fields', async () => {
    const byId = (rows: any[], key: string) => new Map(rows.map((r) => [r[key], r]));
    const search = byId((await get(`/api/v1/libraries/${lib}/search?q=${encodeURIComponent('Offline')}&kind=albums`)).albums, 'id');
    expect(search.get(album.all)).toMatchObject({ filesOffline: 'all', offlineSince: since });
    expect(search.get(album.some)).toMatchObject({ filesOffline: 'some', offlineSince: since });
    expect(search.get(album.online)).toMatchObject({ filesOffline: null, offlineSince: null });

    const artist = byId((await get(`/api/v1/libraries/${lib}/artists/${artistId}`)).albums, 'localAlbumId');
    expect(artist.get(album.all)).toMatchObject({ filesOffline: 'all', offlineSince: since });
    expect(artist.get(album.some)).toMatchObject({ filesOffline: 'some', offlineSince: since });
    expect(artist.get(album.online)).toMatchObject({ filesOffline: null, offlineSince: null });
  });

  describe('Rescan folder (spec §5: a file action still answers 202, with waiting: true)', () => {
    const rescan = async (albumId: string) => {
      const res = await app.inject({ method: 'POST', url: `/api/v1/libraries/${lib}/albums/${albumId}/rescan`, headers: { 'x-test-user': userId }, payload: {} });
      expect(res.statusCode, res.body).toBe(202);
      return res.json();
    };

    it('says it waits when a folder it queues is on an offline or unconnected root', async () => {
      const some = await rescan(album.some);
      expect(some).toMatchObject({ waiting: true });
      expect(some.queued).toHaveLength(2);
      await setReach(offRoot, 'unmounted', since);
      expect(await rescan(album.all)).toMatchObject({ waiting: true });
    });

    it('carries no waiting key when every folder it queues is online', async () => {
      expect(await rescan(album.online)).not.toHaveProperty('waiting');
      await setReach(offRoot, 'online', null);
      expect(await rescan(album.all)).not.toHaveProperty('waiting');
    });

    it('a turned-off root does not count as not online', async () => {
      await client`update scan_roots set enabled = false where id = ${offRoot}`;
      try {
        expect(await rescan(album.some)).not.toHaveProperty('waiting');
      } finally {
        await client`update scan_roots set enabled = true where id = ${offRoot}`;
      }
    });
  });
});
