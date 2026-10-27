/**
 * The play queue per person (0055) against a real database and a fake
 * Navidrome: tracks from any albums resolved as the queue plays them, the
 * queue following the person from one device to another (the device that
 * wrote last plays), each person seeing only their own, and the history
 * read from their plays.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { close, fakeNavidrome, listen } from '../testkit/playerFakes.js';

vi.mock('../boss.js', () => ({ getBoss: async () => ({ send: async () => 'job' }) }));

const PASSWORD = 'nav-admin-pw';

describe.skipIf(!process.env.TEST_DATABASE_URL)('the play queue per person', () => {
  let app: FastifyInstance;
  let sql: any;
  const nav = fakeNavidrome(PASSWORD);
  const anna = randomUUID();
  const ben = randomUUID();
  const libraryId = randomUUID();
  const rootId = randomUUID();
  const albums = { a: randomUUID(), b: randomUUID() };
  const t = { a1: randomUUID(), a2: randomUUID(), b1: randomUUID(), b2: randomUUID() };
  const as = (user: string) => ({ 'x-test-user': user, 'x-test-role': 'listener' });
  const envKeys = ['TAGAVE_PLAYER_URL', 'TAGAVE_PLAYER_USER', 'TAGAVE_PLAYER_PASSWORD', 'APP_SECRET'] as const;
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const k of envKeys) savedEnv[k] = process.env[k];
    process.env['APP_SECRET'] = 'test-app-secret-'.padEnd(48, 'q');
    process.env['TAGAVE_PLAYER_URL'] = await listen(nav.server);
    process.env['TAGAVE_PLAYER_USER'] = 'admin';
    process.env['TAGAVE_PLAYER_PASSWORD'] = PASSWORD;
    const { initDb } = await import('../db.js');
    sql = (await initDb(process.env.TEST_DATABASE_URL!)).client;
    (await import('../lib/player.js')).clearCapabilityCache();
    await sql`insert into users (id, email, display_name, password_hash, role) values
      (${anna}, ${`anna-${anna}@t.com`}, 'Anna Queue', 'x', 'owner'), (${ben}, ${`ben-${ben}@t.com`}, 'Ben Queue', 'x', 'listener')`;
    await sql`insert into libraries (id, owner_user_id, name, settings) values (${libraryId}, ${anna}, 'Queue', '{}'::jsonb)`;
    await sql`insert into scan_roots (id, library_id, path, display_name, validation_status) values (${rootId}, ${libraryId}, '/mnt/music', 'Music', 'ok')`;
    const album = (id: string, title: string) => sql`insert into local_albums (id, library_id, cluster_key, title_guess, artist_guess, year_guess, state)
      values (${id}, ${libraryId}, ${`ck-${id}`}, ${title}, 'The Queues', 1999, 'matched')`;
    await album(albums.a, 'First Album');
    await album(albums.b, 'Second Album');
    const track = async (id: string, albumId: string, no: number, title: string, folder: string) => {
      const fileId = randomUUID();
      await sql`insert into audio_files (id, library_id, scan_root_id, rel_path, container, codec, lossless, duration_ms, status)
        values (${fileId}, ${libraryId}, ${rootId}, ${`The Queues/${folder}/0${no} ${title}.flac`}, 'flac', 'FLAC', true, 180000, 'present')`;
      await sql`insert into local_tracks (id, local_album_id, audio_file_id, disc_no, track_no, title_guess, artist_guess, duration_ms, origin)
        values (${id}, ${albumId}, ${fileId}, 1, ${no}, ${title}, 'The Queues', 180000, 'file')`;
    };
    await track(t.a1, albums.a, 1, 'One', 'First Album');
    await track(t.a2, albums.a, 2, 'Two', 'First Album');
    await track(t.b1, albums.b, 1, 'Three', 'Second Album');
    await track(t.b2, albums.b, 2, 'Four', 'Second Album');
    for (const [id, name, folder, songs] of [['al-a', 'First Album', 'First Album', ['One', 'Two']], ['al-b', 'Second Album', 'Second Album', ['Three', 'Four']]] as const) {
      nav.state.albums.push({
        id, name, artist: 'The Queues', musicBrainzId: randomUUID(), songs: songs.map((title, i) => ({ id: `${id}-${i + 1}`, title, track: i + 1, discNumber: 1, path: `/music/The Queues/${folder}/0${i + 1} ${title}.flac`, duration: 180 })),
      });
    }
    const { errorHandler } = await import('../middleware/errorHandler.js');
    const { createPlayerQueueRoutes } = await import('./playerQueue.js');
    app = Fastify({ logger: false });
    await errorHandler(app);
    app.addHook('preHandler', async (request) => {
      const id = request.headers['x-test-user'];
      request.user = typeof id === 'string' ? ({ id, email: `${id}@t.com`, role: request.headers['x-test-role'] } as any) : undefined;
    });
    await app.register(createPlayerQueueRoutes, { prefix: '/api/v1' });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await close(nav.server);
    if (sql) {
      await sql`delete from libraries where id = ${libraryId}`;
      await sql`delete from users where id in (${anna}, ${ben})`;
      await sql.end({ timeout: 5 });
    }
    for (const k of envKeys) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  const put = (user: string, body: unknown) => app.inject({ method: 'PUT', url: '/api/v1/me/player/queue', headers: as(user), payload: body as object });
  const get = (user: string, url: string) => app.inject({ method: 'GET', url, headers: as(user) });

  it('resolves tracks from different albums, in the order asked, with their albums', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/player/tracks', headers: as(anna), payload: { ids: [t.b2, t.a1, randomUUID()] } });
    expect(res.statusCode).toBe(200);
    const { tracks } = res.json();
    expect(tracks.map((x: any) => [x.localTrackId, x.title, x.albumId, x.album, x.available, x.year])).toEqual([
      [t.b2, 'Four', albums.b, 'Second Album', true, 1999],
      [t.a1, 'One', albums.a, 'First Album', true, 1999],
    ]);
    expect((await app.inject({ method: 'POST', url: '/api/v1/player/tracks', headers: as(anna), payload: { ids: ['nope'] } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/v1/player/tracks', payload: { ids: [t.a1] } })).statusCode).toBe(401);
  });

  it('starts empty', async () => {
    expect((await get(anna, '/api/v1/me/player/queue')).json()).toEqual({ items: [], context: null, index: -1, positionMs: 0, deviceId: null, updatedAt: null });
    expect((await get(anna, '/api/v1/me/player/queue/stamp')).json()).toEqual({ deviceId: null, updatedAt: null });
  });

  it('follows the person to another device; the device that wrote last is the one that plays', async () => {
    const laptop = 'laptop-1234567';
    const phone = 'phone-12345678';
    const first = await put(anna, {
      items: [{ id: t.a1, origin: 'context' }, { id: t.b1, origin: 'queued' }, { id: t.a2, origin: 'context' }],
      context: { kind: 'album', id: albums.a, name: 'First Album' }, index: 0, positionMs: 42_000, deviceId: laptop,
    });
    expect(first.statusCode, first.body).toBe(200);
    // the phone opens tagave: the same queue, at the same place, written by the laptop
    const seen = (await get(anna, '/api/v1/me/player/queue')).json();
    expect(seen).toMatchObject({ index: 0, positionMs: 42_000, deviceId: laptop, context: { kind: 'album', name: 'First Album' } });
    expect(seen.items.map((i: any) => [i.title, i.origin, i.album])).toEqual([['One', 'context', 'First Album'], ['Three', 'queued', 'Second Album'], ['Two', 'context', 'First Album']]);
    // the phone plays: it writes, and the laptop's next look says so
    const second = await put(anna, { items: [{ id: t.a1, origin: 'context' }, { id: t.b1, origin: 'queued' }, { id: t.a2, origin: 'context' }], context: null, index: 1, positionMs: 0, deviceId: phone });
    const stamp = (await get(anna, '/api/v1/me/player/queue/stamp')).json();
    expect(stamp.deviceId).toBe(phone);
    expect(stamp.updatedAt).toBe(second.json().updatedAt);
    expect(Date.parse(stamp.updatedAt)).toBeGreaterThan(Date.parse(first.json().updatedAt));
  });

  it('each person has their own queue', async () => {
    expect((await get(ben, '/api/v1/me/player/queue')).json().items).toEqual([]);
    await put(ben, { items: [{ id: t.b2, origin: 'context' }], context: null, index: 0, positionMs: 0, deviceId: 'ben-device-1' });
    expect((await get(anna, '/api/v1/me/player/queue')).json().items).toHaveLength(3);
    expect((await get(ben, '/api/v1/me/player/queue')).json().items.map((i: any) => i.title)).toEqual(['Four']);
  });

  it('a track that left the library drops out, and the next one takes the playing place', async () => {
    await put(anna, { items: [{ id: t.a1, origin: 'context' }, { id: t.b1, origin: 'queued' }, { id: t.a2, origin: 'context' }], context: null, index: 1, positionMs: 9000, deviceId: 'laptop-1234567' });
    await sql`update player_queue_state set items = ${JSON.stringify([{ id: t.a1, origin: 'context' }, { id: randomUUID(), origin: 'queued' }, { id: t.a2, origin: 'context' }])}::text::jsonb where user_id = ${anna}`;
    const q = (await get(anna, '/api/v1/me/player/queue')).json();
    expect(q.items.map((i: any) => i.title)).toEqual(['One', 'Two']);
    expect(q.index).toBe(1);
    expect(q.positionMs).toBe(0);
  });

  it('refuses what is not a queue, and Stop forgets it', async () => {
    expect((await put(anna, { items: [{ id: 'x', origin: 'context' }], context: null, index: 0, positionMs: 0, deviceId: 'laptop-1234567' })).statusCode).toBe(400);
    expect((await put(anna, { items: [], context: null, index: 0, positionMs: -1, deviceId: 'laptop-1234567' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/me/player/queue', headers: as(anna) })).statusCode).toBe(200);
    expect((await get(anna, '/api/v1/me/player/queue')).json().items).toEqual([]);
    expect((await get(ben, '/api/v1/me/player/queue')).json().items).toHaveLength(1);
  });

  it('history: the person’s own plays, newest first', async () => {
    const play = (user: string, trackId: string, title: string, minutesAgo: number) => sql`
      insert into player_plays (user_id, library_id, dedupe_key, source, local_track_id, local_album_id, title, artist, album, duration_ms, played_ms, started_at, heard, scrobbles)
      values (${user}, ${libraryId}, ${`test:${randomUUID()}`}, 'web', ${trackId}, ${trackId === t.a1 ? albums.a : albums.b}, ${title}, 'The Queues', 'Album', 180000, 180000, now() - make_interval(mins => ${minutesAgo}), true, true)`;
    await play(anna, t.a1, 'One', 30);
    await play(anna, t.b1, 'Three', 10);
    await play(ben, t.b2, 'Four', 5);
    const h = (await get(anna, '/api/v1/me/player/history')).json();
    expect(h.plays.map((p: any) => [p.title, p.localTrackId, p.albumId])).toEqual([['Three', t.b1, albums.b], ['One', t.a1, albums.a]]);
  });
});
