/**
 * Cast links against the test database and a fake Subsonic server: minting
 * (PUBLIC_URL, the cover, reach, the limit), and the token routes: the same
 * audio as /player/stream with ranges, by the token alone, refused when it
 * is tampered with, expired, for another track or for a person turned off.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AddressInfo } from 'node:net';
import { fakeNavidrome } from '../testkit/playerFakes.js';

vi.mock('../boss.js', () => ({ getBoss: async () => ({ send: async () => 'job' }) }));

const PASSWORD = 'nav-secret-pw';
describe.skipIf(!process.env.TEST_DATABASE_URL)('cast links', () => {
  let app: FastifyInstance;
  let sql: any;
  const nav = fakeNavidrome(PASSWORD);
  const AUDIO = nav.AUDIO;
  const ownerId = randomUUID();
  const listenerId = randomUUID();
  const libraryId = randomUUID();
  const rootId = randomUUID();
  const albumId = randomUUID();
  const bareAlbumId = randomUUID();
  const tracks = { one: randomUUID(), two: randomUUID() };
  const files = { one: randomUUID(), two: randomUUID() };
  const thumb = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9]);
  const as = (user: string, role = 'owner') => ({ 'x-test-user': user, 'x-test-role': role });
  const envKeys = ['TAGAVE_PLAYER_URL', 'TAGAVE_PLAYER_USER', 'TAGAVE_PLAYER_PASSWORD', 'APP_SECRET', 'PUBLIC_URL'] as const;
  const savedEnv: Record<string, string | undefined> = {};
  const pack = (u: string) => Buffer.from(u.replace(/-/g, ''), 'hex').toString('base64url');
  const pathOf = (url: string) => new URL(url).pathname + new URL(url).search;
  const mint = (body: Record<string, unknown>, user = ownerId, role = 'owner') =>
    app.inject({ method: 'POST', url: '/api/v1/player/cast-url', headers: as(user, role), payload: body });

  beforeAll(async () => {
    for (const k of envKeys) savedEnv[k] = process.env[k];
    process.env['APP_SECRET'] = 'test-app-secret-'.padEnd(48, 'x');
    await new Promise<void>((r) => nav.server.listen(0, '127.0.0.1', () => r()));
    const base = `http://127.0.0.1:${(nav.server.address() as AddressInfo).port}`;
    process.env['TAGAVE_PLAYER_URL'] = base;
    process.env['TAGAVE_PLAYER_USER'] = 'admin';
    process.env['TAGAVE_PLAYER_PASSWORD'] = PASSWORD;

    const { initDb } = await import('../db.js');
    sql = (await initDb(process.env.TEST_DATABASE_URL!)).client;
    await sql`insert into users (id, email, password_hash, role) values (${ownerId}, ${`o-${ownerId}@t.com`}, 'x', 'owner'), (${listenerId}, ${`l-${listenerId}@t.com`}, 'x', 'listener')`;
    await sql`insert into libraries (id, owner_user_id, name, settings) values (${libraryId}, ${ownerId}, 'Cast', '{}'::jsonb)`;
    await sql`insert into scan_roots (id, library_id, path, display_name, validation_status) values (${rootId}, ${libraryId}, '/mnt/music', 'Music', 'ok')`;
    for (const id of [albumId, bareAlbumId]) {
      await sql`insert into local_albums (id, library_id, cluster_key, title_guess, artist_guess, state) values (${id}, ${libraryId}, ${`ck-${id}`}, 'Cast Album', 'Cast Artist', 'matched')`;
    }
    const file = (id: string, rel: string) =>
      sql`insert into files (id, library_id, scan_root_id, rel_path, container, codec, lossless, duration_ms, status, handler)
          values (${id}, ${libraryId}, ${rootId}, ${rel}, 'flac', 'FLAC', true, 200000, 'present', 'audio')`;
    await file(files.one, 'Cast Artist/Cast Album/01 One.flac');
    await file(files.two, 'Cast Artist/Bare/01 Two.flac');
    await sql`insert into local_tracks (id, local_album_id, audio_file_id, disc_no, track_no, title_guess, duration_ms, origin)
              values (${tracks.one}, ${albumId}, ${files.one}, 1, 1, 'One', 200000, 'file'), (${tracks.two}, ${bareAlbumId}, ${files.two}, 1, 1, 'Two', 200000, 'file')`;
    const [img] = await sql`insert into images (library_id, entity_type, entity_id, local_album_id, kind, origin, license_note)
              values (${libraryId}, 'local_album', ${albumId}, ${albumId}, 'front', 'owner', 'test') returning id`;
    await sql`insert into cover_thumbs (image_id, bytes, sha256) values (${img.id}, ${thumb}, sha256(${thumb}::bytea))`;
    // the stream resolves the song by its id on the server, known here already
    await sql`insert into player_track_map (local_track_id, server_key, song_id, matched_by) values (${tracks.one}, 'bundled', 'song-1', 'path'), (${tracks.two}, 'bundled', 'song-2', 'path')`;
    nav.state.songs = [
      { id: 'song-1', title: 'One', track: 1, discNumber: 1, path: '/music/Cast Artist/Cast Album/01 One.flac', duration: 200 },
      { id: 'song-2', title: 'Two', track: 1, discNumber: 1, path: '/music/Cast Artist/Bare/01 Two.flac', duration: 200 },
    ];

    const { errorHandler } = await import('../middleware/errorHandler.js');
    const { createPlayerRoutes } = await import('./player.js');
    const { createImageRoutes } = await import('./images.js');
    app = Fastify({ logger: false });
    await errorHandler(app);
    app.addHook('preHandler', async (request) => {
      const id = request.headers['x-test-user'];
      request.user = typeof id === 'string' ? ({ id, email: `${id}@t.com`, role: request.headers['x-test-role'] } as any) : undefined;
    });
    await app.register(createPlayerRoutes, { prefix: '/api/v1' });
    await app.register(createImageRoutes, { prefix: '/api/v1', requestRebuild: async () => undefined });
    await app.ready();
  });

  beforeEach(async () => {
    process.env['PUBLIC_URL'] = 'https://music.example.test/';
    const { castMintLimit } = await import('./player.js');
    (castMintLimit as any).hits.clear();
    await sql`update users set disabled_at = null, role = 'listener' where id = ${listenerId}`;
  });

  afterAll(async () => {
    app?.server.closeAllConnections();
    await app?.close();
    nav.server.closeAllConnections();
    await new Promise<void>((r) => nav.server.close(() => r()));
    if (sql) {
      await sql`delete from libraries where id = ${libraryId}`;
      await sql`delete from player_users where user_id in (${ownerId}, ${listenerId})`;
      await sql`delete from users where id in (${ownerId}, ${listenerId})`;
      await sql.end({ timeout: 5 });
    }
    for (const k of envKeys) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  it('mints a link on PUBLIC_URL for one track, with its cover, and says how reachable it is', async () => {
    const res = await mint({ localTrackId: tracks.one, format: 'original' });
    expect(res.statusCode).toBe(200);
    const view = res.json();
    expect(view.url).toMatch(/^https:\/\/music\.example\.test\/api\/v1\/player\/cast\/v1\.t\.[\w-]{22}\.[\w-]{22}\.[0-9a-z]+\.[\w-]{22}\?format=original$/);
    expect(view.coverUrl).toMatch(/^https:\/\/music\.example\.test\/api\/v1\/player\/cast-cover\/v1\.c\./);
    expect(view.reach).toBe('ok');
    expect(new URL(view.url).pathname.split('/').at(-1)!.length).toBeLessThanOrEqual(100);
    const hours = (Date.parse(view.expiresAt) - Date.now()) / 3600_000;
    expect(hours).toBeGreaterThan(5.9);
    expect(hours).toBeLessThanOrEqual(6);
    // a transcode keeps its bitrate; no cover, no cover link
    const opus = (await mint({ localTrackId: tracks.two, format: 'opus', maxBitRate: 160 })).json();
    expect(opus.url).toMatch(/\?format=opus&maxBitRate=160$/);
    expect(opus.coverUrl).toBeNull();
  });

  it('says when PUBLIC_URL is plain http, localhost or missing', async () => {
    process.env['PUBLIC_URL'] = 'http://192.0.2.10:3000';
    expect((await mint({ localTrackId: tracks.one })).json().reach).toBe('http');
    process.env['PUBLIC_URL'] = 'http://localhost:3000';
    expect((await mint({ localTrackId: tracks.one })).json().reach).toBe('loopback');
    delete process.env['PUBLIC_URL'];
    const none = (await mint({ localTrackId: tracks.one })).json();
    expect(none).toMatchObject({ reach: 'unset', url: null, coverUrl: null });
  });

  it('refuses a bad body, an unknown track, nobody signed in, and too many links', async () => {
    expect((await mint({ localTrackId: 'nope' })).statusCode).toBe(400);
    expect((await mint({ localTrackId: tracks.one, extra: 1 })).statusCode).toBe(400);
    expect((await mint({ localTrackId: randomUUID() })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/v1/player/cast-url', payload: { localTrackId: tracks.one } })).statusCode).toBe(401);
    const { castMintLimit } = await import('./player.js');
    for (let i = 0; i < castMintLimit.max; i++) expect((await mint({ localTrackId: tracks.one }, listenerId, 'listener')).statusCode).toBe(200);
    const over = await mint({ localTrackId: tracks.one }, listenerId, 'listener');
    expect(over.statusCode).toBe(429);
    expect(Number(over.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('streams by the token alone, with ranges, as the person who minted it', async () => {
    const { url } = (await mint({ localTrackId: tracks.one }, listenerId, 'listener')).json();
    const full = await app.inject({ method: 'GET', url: pathOf(url) });
    expect(full.statusCode).toBe(200);
    expect(full.rawPayload.equals(AUDIO)).toBe(true);
    expect(full.headers['content-type']).toBe('audio/flac');
    expect(full.headers['accept-ranges']).toBe('bytes');
    expect(full.headers['access-control-allow-origin']).toBe('*');
    const part = await app.inject({ method: 'GET', url: pathOf(url), headers: { range: 'bytes=100-199' } });
    expect(part.statusCode).toBe(206);
    expect(part.headers['content-range']).toBe(`bytes 100-199/${AUDIO.length}`);
    expect(part.rawPayload.equals(AUDIO.subarray(100, 200))).toBe(true);
    // the listener's own account on the player server, not the owner's or the admin's
    const [account] = await sql`select username from player_users where user_id = ${listenerId} and server_key = 'bundled'`;
    expect(nav.state.streams.at(-1)!.user).toBe(account.username);
    expect(JSON.stringify(part.headers)).not.toContain(PASSWORD);
  });

  it('refuses a tampered, expired or wrong-kind token, and one for a person turned off', async () => {
    const { url } = (await mint({ localTrackId: tracks.one }, listenerId, 'listener')).json();
    const path = new URL(url).pathname;
    const token = path.split('/').at(-1)!;
    const [v, k, id, user, exp, sig] = token.split('.');
    const at = (t: string) => app.inject({ method: 'GET', url: `/api/v1/player/cast/${t}` });
    // another track under the same signature
    expect((await at([v, k, pack(tracks.two), user, exp, sig].join('.'))).statusCode).toBe(403);
    // another person, a later expiry, a flipped signature
    expect((await at([v, k, id, pack(ownerId), exp, sig].join('.'))).statusCode).toBe(403);
    expect((await at([v, k, id, user, (parseInt(exp!, 36) + 3600).toString(36), sig].join('.'))).statusCode).toBe(403);
    expect((await at([v, k, id, user, exp, `${sig!.slice(0, -2)}AA`].join('.'))).statusCode).toBe(403);
    expect((await at('garbage')).statusCode).toBe(403);
    // a cover token does not open audio
    const { coverUrl } = (await mint({ localTrackId: tracks.one }, listenerId, 'listener')).json();
    expect((await at(new URL(coverUrl).pathname.split('/').at(-1)!)).statusCode).toBe(403);
    // expired
    const { mintCastToken } = await import('../lib/castTokens.js');
    const old = mintCastToken('t', tracks.one, listenerId, { now: Date.now() - 7 * 3600_000 });
    expect((await at(old.token)).statusCode).toBe(403);
    // the account turned off: its links stop at once
    await sql`update users set disabled_at = now() where id = ${listenerId}`;
    expect((await at(token)).statusCode).toBe(403);
    await sql`update users set disabled_at = null where id = ${listenerId}`;
    expect((await at(token)).statusCode).toBe(200);
  });

  it('serves the cover by its token, and refuses a tampered one', async () => {
    const { coverUrl } = (await mint({ localTrackId: tracks.one })).json();
    const res = await app.inject({ method: 'GET', url: pathOf(coverUrl) });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(res.rawPayload.equals(thumb)).toBe(true);
    const bad = pathOf(coverUrl).replace(pack(albumId), pack(bareAlbumId));
    expect((await app.inject({ method: 'GET', url: bad })).statusCode).toBe(403);
  });
});
