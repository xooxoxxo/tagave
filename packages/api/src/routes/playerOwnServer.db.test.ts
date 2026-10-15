/**
 * A server the owner runs (bring your own): each person may enter their own
 * login there; without one they play through the shared account. A server
 * that scrobbles for a person already gets their plays, and tagave sends no
 * scrobble of its own (never two).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { close, fakeListenbrainz, fakeNavidrome, listen } from '../testkit/playerFakes.js';

vi.mock('../boss.js', () => ({ getBoss: async () => ({ send: async () => 'job' }) }));

const PASSWORD = 'own-admin-pw';

describe.skipIf(!process.env.TEST_DATABASE_URL)('the player on the owner’s own server', () => {
  let app: FastifyInstance;
  let sql: any;
  const nav = fakeNavidrome(PASSWORD);
  const lb = fakeListenbrainz({ 'token-cara': 'cara-lb', 'token-dan': 'dan-lb' });
  const cara = randomUUID();
  const dan = randomUUID();
  const libraryId = randomUUID();
  const rootId = randomUUID();
  const albumId = randomUUID();
  const trackId = randomUUID();
  const fileId = randomUUID();
  const as = (user: string, role = 'listener') => ({ 'x-test-user': user, 'x-test-role': role });
  const envKeys = ['TAGAVE_PLAYER_URL', 'TAGAVE_PLAYER_USER', 'TAGAVE_PLAYER_PASSWORD', 'APP_SECRET', 'TAGAVE_LISTENBRAINZ_API_URL'] as const;
  const savedEnv: Record<string, string | undefined> = {};
  let base = '';

  beforeAll(async () => {
    for (const k of envKeys) savedEnv[k] = process.env[k];
    for (const k of ['TAGAVE_PLAYER_URL', 'TAGAVE_PLAYER_USER', 'TAGAVE_PLAYER_PASSWORD'] as const) delete process.env[k];
    process.env['APP_SECRET'] = 'test-app-secret-'.padEnd(48, 'z');
    base = await listen(nav.server);
    process.env['TAGAVE_LISTENBRAINZ_API_URL'] = await listen(lb.server);
    nav.state.users.set('cara-on-nd', { id: 'nd-cara', password: 'cara-pw', isAdmin: false, name: 'Cara', plays: new Map(), ratings: new Map(), starred: new Set() });

    const { initDb } = await import('../db.js');
    sql = (await initDb(process.env.TEST_DATABASE_URL!)).client;
    await sql`insert into users (id, email, password_hash) values (${cara}, ${`c-${cara}@t.com`}, 'x'), (${dan}, ${`d-${dan}@t.com`}, 'x')`;
    await sql`insert into libraries (id, owner_user_id, name, settings) values (${libraryId}, ${cara}, 'Own', '{}'::jsonb)`;
    await sql`insert into scan_roots (id, library_id, path, display_name, validation_status) values (${rootId}, ${libraryId}, '/mnt/music', 'Music', 'ok')`;
    await sql`insert into local_albums (id, library_id, cluster_key, title_guess, artist_guess, state) values (${albumId}, ${libraryId}, ${`ck-${albumId}`}, 'Own Album', 'Own Artist', 'unidentified')`;
    await sql`insert into audio_files (id, library_id, scan_root_id, rel_path, container, codec, lossless, duration_ms, status)
              values (${fileId}, ${libraryId}, ${rootId}, 'Own Artist/Own Album/01 Only.flac', 'flac', 'FLAC', true, 200000, 'present')`;
    await sql`insert into local_tracks (id, local_album_id, audio_file_id, disc_no, track_no, title_guess, artist_guess, duration_ms, origin)
              values (${trackId}, ${albumId}, ${fileId}, 1, 1, 'Only', 'Own Artist', 200000, 'file')`;
    nav.state.albums.push({ id: 'al-own', name: 'Own Album', artist: 'Own Artist', musicBrainzId: '', songs: [{ id: 's-own', title: 'Only', track: 1, discNumber: 1, path: '/srv/music/Own Artist/Own Album/01 Only.flac', duration: 200 }] });

    const { errorHandler } = await import('../middleware/errorHandler.js');
    const { createPlayerRoutes } = await import('./player.js');
    const { createPlayerListeningRoutes } = await import('./playerListening.js');
    const { clearCapabilityCache } = await import('../lib/player.js');
    clearCapabilityCache();
    app = Fastify({ logger: false });
    await errorHandler(app);
    app.addHook('preHandler', async (request) => {
      const id = request.headers['x-test-user'];
      request.user = typeof id === 'string' ? ({ id, email: `${id}@t.com`, role: request.headers['x-test-role'] } as any) : undefined;
    });
    await app.register(createPlayerRoutes, { prefix: '/api/v1' });
    await app.register(createPlayerListeningRoutes, { prefix: '/api/v1' });
    await app.ready();
    const put = await app.inject({ method: 'PUT', url: `/api/v1/libraries/${libraryId}/player/server`, headers: as(cara, 'owner'), payload: { url: base, username: 'admin', password: PASSWORD } });
    expect(put.statusCode, put.body).toBe(200);
  });

  afterAll(async () => {
    await app?.close();
    await close(nav.server);
    await close(lb.server);
    if (sql) {
      await sql`delete from libraries where id = ${libraryId}`;
      await sql`delete from users where id in (${cara}, ${dan})`;
      await sql.end({ timeout: 5 });
    }
    for (const k of envKeys) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  const play = async (user: string) => {
    const q = randomUUID();
    await app.inject({ method: 'POST', url: '/api/v1/player/events', headers: as(user), payload: { kind: 'completed', localTrackId: trackId, queueId: q, playedMs: 190_000, positionMs: 200_000 } });
  };

  it('plays through the shared account until a person enters their own login', async () => {
    const view = await app.inject({ method: 'GET', url: `/api/v1/me/listening?libraryId=${libraryId}`, headers: as(dan) });
    expect(view.json().account).toMatchObject({ kind: 'shared', username: null });
    expect((await app.inject({ method: 'GET', url: `/api/v1/player/albums/${albumId}/queue`, headers: as(dan) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/api/v1/player/stream/${trackId}`, headers: as(dan) })).statusCode).toBe(200);
    expect(nav.state.streams.at(-1)!.user).toBe('admin');
    // the wrong password is refused, the right one saved sealed
    const wrong = await app.inject({ method: 'PUT', url: `/api/v1/me/listening/account?libraryId=${libraryId}`, headers: as(cara), payload: { username: 'cara-on-nd', password: 'nope' } });
    expect(wrong.statusCode).toBe(400);
    const ok = await app.inject({ method: 'PUT', url: `/api/v1/me/listening/account?libraryId=${libraryId}`, headers: as(cara), payload: { username: 'cara-on-nd', password: 'cara-pw', serverScrobbles: true } });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().account).toEqual({ kind: 'own', username: 'cara-on-nd', phonePassword: false, serverScrobbles: true, state: 'active', lastError: null });
    expect((await app.inject({ method: 'GET', url: `/api/v1/player/stream/${trackId}`, headers: as(cara) })).statusCode).toBe(200);
    expect(nav.state.streams.at(-1)!.user).toBe('cara-on-nd');
    // nobody else may claim the same login
    const taken = await app.inject({ method: 'PUT', url: `/api/v1/me/listening/account?libraryId=${libraryId}`, headers: as(dan), payload: { username: 'cara-on-nd', password: 'cara-pw' } });
    expect(taken.statusCode).toBe(409);
  });

  it('leaves scrobbling to a server that does it for the person, and scrobbles itself for everyone else', async () => {
    const { runPlayerFastSync } = await import('../lib/playerSync.js');
    for (const [user, token] of [[cara, 'token-cara'], [dan, 'token-dan']] as const) {
      const r = await app.inject({ method: 'POST', url: '/api/v1/me/listening/listenbrainz', headers: as(user), payload: { token } });
      expect(r.statusCode, r.body).toBe(200);
    }
    await play(cara);
    await play(dan);
    await runPlayerFastSync({ sql });
    // Cara's play went to her account on the server (which scrobbles it); tagave sent nothing for her
    expect(nav.state.scrobbles.filter((s) => s.submission).map((s) => s.user)).toEqual(['cara-on-nd']);
    expect(lb.state.listens.filter((l) => l.body.listen_type === 'single').map((l) => l.user)).toEqual(['dan-lb']);
    const [caraPlay] = await sql`select server_report from player_plays where user_id = ${cara}`;
    expect(caraPlay.server_report).toBe('done');
    // Dan, on the shared account, is not reported to the server (it cannot tell people apart)
    const [danPlay] = await sql`select server_report from player_plays where user_id = ${dan}`;
    expect(danPlay.server_report).toBe('none');
    // and no album listen for an album without a release group: the play is still in the history
    const h = await app.inject({ method: 'GET', url: '/api/v1/me/listening/history', headers: as(dan) });
    expect(h.json().plays).toHaveLength(1);
  });
});
