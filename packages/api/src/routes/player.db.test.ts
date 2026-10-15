/**
 * The player module against the test database and a fake Subsonic server:
 * capabilities, bring-your-own settings, the album queue (path, recording
 * MBID and not-yet-scanned tracks), the stream proxy (ranges, limits,
 * a song id that changed), play events and the debounced scan.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import { fakeNavidrome } from '../testkit/playerFakes.js';

const sent: Array<{ name: string; data: unknown; opts: unknown }> = [];
vi.mock('../boss.js', () => ({
  getBoss: async () => ({ send: async (name: string, data: unknown, opts: unknown) => { sent.push({ name, data, opts }); return 'job'; } }),
}));

const PASSWORD = 'nav-secret-pw';
describe.skipIf(!process.env.TEST_DATABASE_URL)('player routes', () => {
  let app: FastifyInstance;
  let sql: any;
  let base = '';
  const nav = fakeNavidrome(PASSWORD);
  const AUDIO = nav.AUDIO;
  const ownerId = randomUUID();
  const strangerId = randomUUID();
  const libraryId = randomUUID();
  const rootId = randomUUID();
  const albumId = randomUUID();
  const rgId = randomUUID();
  const releaseId = randomUUID();
  const releaseMbid = randomUUID();
  const recMbid2 = randomUUID();
  const tracks = { one: randomUUID(), two: randomUUID(), three: randomUUID(), cue: randomUUID() };
  const files = { one: randomUUID(), two: randomUUID(), three: randomUUID(), cue: randomUUID() };
  const as = (user: string, role = 'owner') => ({ 'x-test-user': user, 'x-test-role': role });
  const envKeys = ['TAGAVE_PLAYER_URL', 'TAGAVE_PLAYER_USER', 'TAGAVE_PLAYER_PASSWORD', 'APP_SECRET'] as const;
  const savedEnv: Record<string, string | undefined> = {};

  const bundled = () => {
    process.env['TAGAVE_PLAYER_URL'] = base;
    process.env['TAGAVE_PLAYER_USER'] = 'admin';
    process.env['TAGAVE_PLAYER_PASSWORD'] = PASSWORD;
  };
  const noBundled = () => {
    delete process.env['TAGAVE_PLAYER_URL'];
    delete process.env['TAGAVE_PLAYER_USER'];
    delete process.env['TAGAVE_PLAYER_PASSWORD'];
  };

  beforeAll(async () => {
    for (const k of envKeys) savedEnv[k] = process.env[k];
    process.env['APP_SECRET'] = 'test-app-secret-'.padEnd(48, 'x');
    await new Promise<void>((r) => nav.server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(nav.server.address() as AddressInfo).port}`;

    const { initDb } = await import('../db.js');
    const made = await initDb(process.env.TEST_DATABASE_URL!);
    sql = made.client;
    await sql`insert into users (id, email, password_hash) values (${ownerId}, ${`o-${ownerId}@t.com`}, 'x'), (${strangerId}, ${`s-${strangerId}@t.com`}, 'x')`;
    await sql`insert into libraries (id, owner_user_id, name, settings) values (${libraryId}, ${ownerId}, 'Player', '{}'::jsonb)`;
    await sql`insert into scan_roots (id, library_id, path, display_name, validation_status) values (${rootId}, ${libraryId}, '/mnt/music', 'Music', 'ok')`;
    await sql`insert into release_groups (id, mbid, title) values (${rgId}, ${randomUUID()}, 'Test Album')`;
    await sql`insert into releases (id, release_group_id, mbid, title) values (${releaseId}, ${rgId}, ${releaseMbid}, 'Test Album')`;
    const ct2 = randomUUID();
    await sql`insert into canonical_tracks (id, release_id, medium_no, position, title, recording_mbid) values (${ct2}, ${releaseId}, 1, 2, 'Two', ${recMbid2})`;
    await sql`insert into local_albums (id, library_id, cluster_key, title_guess, artist_guess, state, release_id, release_group_id)
              values (${albumId}, ${libraryId}, ${`ck-${albumId}`}, 'Test Album', 'Test Artist', 'matched', ${releaseId}, ${rgId})`;
    const file = (id: string, rel: string, container = 'flac') =>
      sql`insert into audio_files (id, library_id, scan_root_id, rel_path, container, codec, lossless, duration_ms, status)
          values (${id}, ${libraryId}, ${rootId}, ${rel}, ${container}, 'FLAC', true, 200000, 'present')`;
    await file(files.one, 'Test Artist/Test Album/01 One.flac');
    await file(files.two, 'Test Artist/Test Album/02 Two.flac');
    await file(files.three, 'Test Artist/Test Album/03 Three.flac');
    await file(files.cue, 'Test Artist/Test Album/image.flac');
    const track = (id: string, fileId: string, no: number, title: string, extra: { ct?: string; origin?: string } = {}) =>
      sql`insert into local_tracks (id, local_album_id, audio_file_id, disc_no, track_no, title_guess, duration_ms, canonical_track_id, origin)
          values (${id}, ${albumId}, ${fileId}, 1, ${no}, ${title}, 200000, ${extra.ct ?? null}, ${extra.origin ?? 'file'})`;
    await track(tracks.one, files.one, 1, 'One');
    await track(tracks.two, files.two, 2, 'Two', { ct: ct2 });
    await track(tracks.three, files.three, 3, 'Three');
    await track(tracks.cue, files.cue, 4, 'Cue piece', { origin: 'cue' });

    nav.state.albumMbid = releaseMbid;
    nav.state.songs = [
      // real path: matched by path
      { id: 'song-1', title: 'One', track: 1, discNumber: 1, path: '/music/Test Artist/Test Album/01 One.flac', duration: 200 },
      // made-up path: matched by recording MBID
      { id: 'song-2', title: 'Two', track: 2, discNumber: 1, path: 'Test Artist/Test Album/02 - Two.flac', musicBrainzId: recMbid2, duration: 200 },
    ];

    const { errorHandler } = await import('../middleware/errorHandler.js');
    const { createPlayerRoutes } = await import('./player.js');
    app = Fastify({ logger: process.env.PLAYER_TEST_LOG ? { level: 'error' } : false });
    await errorHandler(app);
    app.addHook('preHandler', async (request) => {
      const id = request.headers['x-test-user'];
      request.user = typeof id === 'string' ? ({ id, email: `${id}@t.com`, role: request.headers['x-test-role'] } as any) : undefined;
    });
    await app.register(createPlayerRoutes, { prefix: '/api/v1' });
    await app.ready();
  });

  beforeEach(async () => {
    const { clearCapabilityCache } = await import('../lib/player.js');
    clearCapabilityCache();
    noBundled();
    sent.length = 0;
  });

  afterAll(async () => {
    for (const res of nav.state.holds) res.end();
    app?.server.closeAllConnections();
    await app?.close();
    nav.server.closeAllConnections();
    await new Promise<void>((r) => nav.server.close(() => r()));
    if (sql) {
      await sql`delete from libraries where id = ${libraryId}`;
      await sql`delete from releases where id = ${releaseId}`;
      await sql`delete from release_groups where id = ${rgId}`;
      await sql`delete from player_users where user_id in (${ownerId}, ${strangerId})`;
      await sql`delete from users where id in (${ownerId}, ${strangerId})`;
      await sql.end({ timeout: 5 });
    }
    for (const k of envKeys) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  it('says no player is installed, and the player routes answer 404', async () => {
    const cap = await app.inject({ method: 'GET', url: `/api/v1/capabilities?libraryId=${libraryId}`, headers: as(ownerId) });
    expect(cap.json()).toEqual({ player: { installed: false, managed: null, backend: null, version: null, reachable: false, error: null } });
    const q = await app.inject({ method: 'GET', url: `/api/v1/player/albums/${albumId}/queue`, headers: as(ownerId) });
    expect(q.statusCode).toBe(404);
    expect(q.json().detail).toMatch(/not installed/);
    const s = await app.inject({ method: 'GET', url: `/api/v1/player/stream/${tracks.one}`, headers: as(ownerId) });
    expect(s.statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/v1/capabilities' })).statusCode).toBe(401);
  });

  it('reports the bundled server once it answers', async () => {
    bundled();
    const res = await app.inject({ method: 'GET', url: `/api/v1/capabilities?libraryId=${libraryId}`, headers: as(ownerId) });
    expect(res.json().player).toEqual({ installed: true, managed: 'bundled', backend: 'navidrome', version: '0.64.0 (test)', reachable: true, error: null });
    const view = await app.inject({ method: 'GET', url: `/api/v1/libraries/${libraryId}/player`, headers: as(ownerId) });
    expect(view.json()).toMatchObject({ bundled: true, external: null });
    // bring-your-own is refused while the bundled one is configured
    const put = await app.inject({ method: 'PUT', url: `/api/v1/libraries/${libraryId}/player/server`, headers: as(ownerId), payload: { url: base, username: 'admin', password: PASSWORD } });
    expect(put.statusCode).toBe(409);
  });

  it('tests, seals and forgets a bring-your-own server', async () => {
    const wrong = await app.inject({ method: 'PUT', url: `/api/v1/libraries/${libraryId}/player/server`, headers: as(ownerId), payload: { url: base, username: 'admin', password: 'nope' } });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().detail).toMatch(/refused the username or password/);
    const viewer = await app.inject({ method: 'PUT', url: `/api/v1/libraries/${libraryId}/player/server`, headers: as(ownerId, 'viewer'), payload: { url: base, username: 'admin', password: PASSWORD } });
    expect(viewer.statusCode).toBe(403);
    const ok = await app.inject({ method: 'PUT', url: `/api/v1/libraries/${libraryId}/player/server`, headers: as(ownerId), payload: { url: `${base}/`, username: 'admin', password: PASSWORD } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ bundled: false, external: { url: base, username: 'admin', passwordHint: 't-pw' }, capability: { installed: true, managed: 'external', reachable: true } });
    const [row] = await sql`select settings from libraries where id = ${libraryId}`;
    expect(row.settings.playerPassword).toMatch(/^enc:v1:/);
    expect(JSON.stringify(row.settings)).not.toContain(PASSWORD);
    // a new address alone keeps the saved password
    const again = await app.inject({ method: 'PUT', url: `/api/v1/libraries/${libraryId}/player/server`, headers: as(ownerId), payload: { url: base, username: 'admin' } });
    expect(again.statusCode).toBe(200);
    const gone = await app.inject({ method: 'DELETE', url: `/api/v1/libraries/${libraryId}/player/server`, headers: as(ownerId) });
    expect(gone.json()).toMatchObject({ external: null, capability: { installed: false } });
    // another person on the install (a listener) sees the status, never the server's details
    const listenerView = await app.inject({ method: 'GET', url: `/api/v1/libraries/${libraryId}/player`, headers: as(strangerId, 'listener') });
    expect(listenerView.statusCode).toBe(200);
    expect(listenerView.json().external).toBeNull();
    expect((await app.inject({ method: 'POST', url: `/api/v1/libraries/${libraryId}/player/scan`, headers: as(strangerId, 'listener') })).statusCode).toBe(403);
  });

  it('builds the album queue: path, recording MBID, not scanned yet, CUE', async () => {
    bundled();
    const res = await app.inject({ method: 'GET', url: `/api/v1/player/albums/${albumId}/queue`, headers: as(ownerId) });
    expect(res.statusCode).toBe(200);
    const q = res.json();
    expect(q).toMatchObject({ albumId, album: 'Test Album', albumArtist: 'Test Artist', coverUrl: null, scanRequested: true });
    expect(q.tracks.map((t: any) => [t.title, t.available, t.reason])).toEqual([
      ['One', true, null], ['Two', true, null], ['Three', false, 'not_scanned'], ['Cue piece', false, 'cue'],
    ]);
    expect(q.tracks[0]).toMatchObject({ mime: 'audio/flac', container: 'flac', lossless: true });
    const map = await sql`select local_track_id, song_id, matched_by from player_track_map where local_track_id in (${tracks.one}, ${tracks.two}) order by song_id`;
    expect(map.map((m: any) => [m.song_id, m.matched_by])).toEqual([['song-1', 'path'], ['song-2', 'recording']]);
    const req = await sql`select folder from player_scan_requests where library_id = ${libraryId}`;
    expect(req.map((r: any) => r.folder)).toEqual(['Test Artist/Test Album']);
    expect(sent).toEqual([{ name: 'player.scan', data: { libraryId }, opts: expect.objectContaining({ singletonKey: `player.scan:${libraryId}` }) }]);
    // everyone on the install plays the shared library
    expect((await app.inject({ method: 'GET', url: `/api/v1/player/albums/${albumId}/queue`, headers: as(strangerId, 'listener') })).statusCode).toBe(200);
  });

  it('streams the original with ranges, transcodes on request, and never forwards credentials', async () => {
    bundled();
    const full = await app.inject({ method: 'GET', url: `/api/v1/player/stream/${tracks.one}`, headers: as(ownerId) });
    expect(full.statusCode).toBe(200);
    expect(full.rawPayload.equals(AUDIO)).toBe(true);
    expect(full.headers['content-type']).toBe('audio/flac');
    expect(full.headers['accept-ranges']).toBe('bytes');
    const part = await app.inject({ method: 'GET', url: `/api/v1/player/stream/${tracks.one}`, headers: { ...as(ownerId), range: 'bytes=100-199' } });
    expect(part.statusCode).toBe(206);
    expect(part.headers['content-range']).toBe(`bytes 100-199/${AUDIO.length}`);
    expect(part.rawPayload.equals(AUDIO.subarray(100, 200))).toBe(true);
    const opus = await app.inject({ method: 'GET', url: `/api/v1/player/stream/${tracks.two}?format=opus&maxBitRate=160&offset=30`, headers: { ...as(ownerId), range: 'bytes=0-' } });
    expect(opus.statusCode).toBe(200);
    const last = nav.state.streams.at(-1)!;
    // the stream is the person's own on the server, never the admin's
    const [account] = await sql`select username from player_users where user_id = ${ownerId} and server_key = 'bundled'`;
    expect(account.username).toBe(`o-${ownerId}`.slice(0, 24).replace(/[-._]+$/, ''));
    expect(last).toEqual({ id: 'song-2', user: account.username, format: 'opus', range: undefined, timeOffset: '30' });
    expect(nav.state.streams.every((x) => x.user !== 'admin')).toBe(true);
    expect(JSON.stringify(opus.headers)).not.toContain(PASSWORD);
    expect((await app.inject({ method: 'GET', url: `/api/v1/player/stream/${tracks.one}?format=wav`, headers: as(ownerId) })).statusCode).toBe(400);
    // a second person streams as their own account
    expect((await app.inject({ method: 'GET', url: `/api/v1/player/stream/${tracks.one}`, headers: as(strangerId, 'listener') })).statusCode).toBe(200);
    expect(nav.state.streams.at(-1)!.user).not.toBe(account.username);
    expect(await sql`select 1 from player_users where server_key = 'bundled' and user_id in (${ownerId}, ${strangerId})`).toHaveLength(2);
  });

  it('answers 409 for a track the server does not have yet', async () => {
    bundled();
    const res = await app.inject({ method: 'GET', url: `/api/v1/player/stream/${tracks.three}`, headers: as(ownerId) });
    expect(res.statusCode).toBe(409);
    expect(res.json().detail).toMatch(/not on the player yet/);
  });

  it('matches again when the server gave the song a new id', async () => {
    bundled();
    await sql`update player_track_map set song_id = 'stale-id' where local_track_id = ${tracks.one}`;
    nav.state.goneIds.add('stale-id');
    const res = await app.inject({ method: 'GET', url: `/api/v1/player/stream/${tracks.one}`, headers: as(ownerId) });
    expect(res.statusCode).toBe(200);
    const [row] = await sql`select song_id from player_track_map where local_track_id = ${tracks.one}`;
    expect(row.song_id).toBe('song-1');
  });

  it('limits concurrent streams per user and frees them when the listener goes away', async () => {
    bundled();
    const { userStreams } = await import('./player.js');
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as AddressInfo).port;
    nav.state.hold = true;
    const controllers: AbortController[] = [];
    try {
      const open = async () => {
        const c = new AbortController();
        controllers.push(c);
        return fetch(`http://127.0.0.1:${port}/api/v1/player/stream/${tracks.one}`, { headers: as(ownerId), signal: c.signal });
      };
      const held = [];
      for (let i = 0; i < userStreams.max; i++) held.push(await open());
      expect(held.every((r) => r.status === 200)).toBe(true);
      expect(userStreams.count(ownerId)).toBe(userStreams.max);
      const over = await open();
      expect(over.status).toBe(429);
      expect(over.headers.get('retry-after')).toBe('2');
      for (const c of controllers) c.abort();
      for (let i = 0; i < 50 && userStreams.count(ownerId) > 0; i++) await new Promise((r) => setTimeout(r, 20));
      expect(userStreams.count(ownerId)).toBe(0);
    } finally {
      nav.state.hold = false;
      for (const res of nav.state.holds) res.end();
      nav.state.holds.length = 0;
    }
  });

  it('records play events with the ids that were current', async () => {
    bundled();
    const queueId = randomUUID();
    const post = (body: unknown, user = ownerId) => app.inject({ method: 'POST', url: '/api/v1/player/events', headers: as(user), payload: body as any });
    const first = await post({ kind: 'now_playing', localTrackId: tracks.two, queueId, playedMs: 0, positionMs: 0 });
    expect(first.statusCode, first.body).toBe(202);
    expect((await post({ kind: 'completed', localTrackId: tracks.two, queueId, playedMs: 199000, positionMs: 200000, at: '1999-01-01T00:00:00Z' })).statusCode).toBe(202);
    expect((await post({ kind: 'bogus', localTrackId: tracks.two, queueId, playedMs: 0, positionMs: 0 })).statusCode).toBe(400);
    expect((await post({ kind: 'completed', localTrackId: randomUUID(), queueId, playedMs: 1, positionMs: 1 }, strangerId)).statusCode).toBe(404);
    const rows = await sql`select kind, release_id, recording_mbid, server_song_id, local_album_id, played_ms, occurred_at, processed_at
                           from player_events where queue_id = ${queueId} order by received_at`;
    expect(rows.map((r: any) => r.kind)).toEqual(['now_playing', 'completed']);
    expect(rows[1]).toMatchObject({ release_id: releaseId, recording_mbid: recMbid2, server_song_id: 'song-2', local_album_id: albumId, played_ms: 199000, processed_at: null });
    // a client clock far off is replaced by the server's
    expect(Math.abs(new Date(rows[1].occurred_at).getTime() - Date.now())).toBeLessThan(60_000);
  });

  it('drains scan requests into one startScan with folder targets, and waits while the server scans', async () => {
    bundled();
    const { requestPlayerScan, runPlayerScan } = await import('../lib/player.js');
    await sql`delete from player_scan_requests where library_id = ${libraryId}`;
    await requestPlayerScan(sql, null, libraryId, ['A/One', 'B/Two', 'A/One']);
    nav.state.scanning = true;
    expect(await runPlayerScan(sql, libraryId)).toBe('busy');
    nav.state.scanning = false;
    const before = nav.state.scans.length;
    expect(await runPlayerScan(sql, libraryId)).toBe('started');
    expect(nav.state.scans.slice(before)).toEqual([['1:A/One', '1:B/Two']]);
    expect(await sql`select 1 from player_scan_requests where library_id = ${libraryId}`).toHaveLength(0);
    expect(await runPlayerScan(sql, libraryId)).toBe('none');
    // "Scan now" asks for everything: no targets
    const now = await app.inject({ method: 'POST', url: `/api/v1/libraries/${libraryId}/player/scan`, headers: as(ownerId) });
    expect(now.statusCode).toBe(202);
    expect(await runPlayerScan(sql, libraryId)).toBe('started');
    expect(nav.state.scans.at(-1)).toEqual([]);
    const [lib] = await sql`select settings from libraries where id = ${libraryId}`;
    expect(lib.settings.playerLastScan).toMatchObject({ state: 'requested', error: null });
  });
});
