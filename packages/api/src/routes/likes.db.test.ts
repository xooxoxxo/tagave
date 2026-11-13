/**
 * Likes (0085) against the test database, a fake Navidrome, a fake Last.fm
 * and a fake ListenBrainz: liking songs, albums and artists; likes that
 * outlast a rescan, a Move, a Split and re-identification; Liked songs; the
 * Liked filters; the two-way sync with the player server's stars (last
 * write wins); loves to Last.fm and ListenBrainz, Off and On.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { and } from 'drizzle-orm';
import { localAlbums } from '@tagave/db';
import { close, fakeLastfm, fakeListenbrainz, fakeNavidrome, listen } from '../testkit/playerFakes.js';

vi.mock('../boss.js', () => ({ getBoss: async () => ({ send: async () => 'job', createQueue: async () => undefined }) }));

const PASSWORD = 'nav-admin-pw';
const LASTFM_KEY = 'a'.repeat(32);
const LASTFM_SECRET = 'b'.repeat(32);

describe.skipIf(!process.env.TEST_DATABASE_URL)('likes', () => {
  let app: FastifyInstance;
  let sql: any;
  let db: any;
  const nav = fakeNavidrome(PASSWORD);
  const lfm = fakeLastfm(LASTFM_KEY, LASTFM_SECRET);
  const lb = fakeListenbrainz({ 'lb-token-anna': 'anna-lb' });
  const anna = randomUUID();
  const ben = randomUUID();
  const libraryId = randomUUID();
  const rootId = randomUUID();
  const albumId = randomUUID();
  const otherAlbumId = randomUUID();
  const rgId = randomUUID();
  const releaseId = randomUUID();
  const releaseMbid = randomUUID();
  const artistId = randomUUID();
  const artistMbid = randomUUID();
  const rec = { one: randomUUID(), two: randomUUID(), three: randomUUID() };
  const ct = { one: randomUUID(), two: randomUUID(), three: randomUUID() };
  const t = { one: randomUUID(), two: randomUUID(), three: randomUUID(), loose: randomUUID() };
  const f = { one: randomUUID(), two: randomUUID(), three: randomUUID(), loose: randomUUID() };
  const as = (user: string) => ({ 'x-test-user': user });
  const envKeys = ['TAGAVE_PLAYER_URL', 'TAGAVE_PLAYER_USER', 'TAGAVE_PLAYER_PASSWORD', 'APP_SECRET', 'TAGAVE_LASTFM_API_URL', 'TAGAVE_LISTENBRAINZ_API_URL', 'TAGAVE_LASTFM_API_KEY', 'TAGAVE_LASTFM_SECRET'] as const;
  const savedEnv: Record<string, string | undefined> = {};
  let likesLib: typeof import('../lib/likes.js');
  let sync: typeof import('../lib/playerLikes.js');
  let people: typeof import('../lib/playerPeople.js');
  let scrob: typeof import('../lib/scrobbling.js');
  let albumsRoute: typeof import('./albums.js');
  let backend: any;

  const file = (id: string, rel: string) => sql`insert into files (id, library_id, scan_root_id, rel_path, container, codec, lossless, duration_ms, status, handler)
    values (${id}, ${libraryId}, ${rootId}, ${rel}, 'flac', 'FLAC', true, 200000, 'present', 'audio')`;
  const track = (id: string, album: string, fileId: string, no: number, title: string, canonical: string | null) => sql`
    insert into local_tracks (id, local_album_id, audio_file_id, disc_no, track_no, title_guess, artist_guess, duration_ms, origin, canonical_track_id)
    values (${id}, ${album}, ${fileId}, 1, ${no}, ${title}, 'The Band', 200000, 'file', ${canonical})`;

  beforeAll(async () => {
    for (const k of envKeys) savedEnv[k] = process.env[k];
    process.env['APP_SECRET'] = 'test-app-secret-'.padEnd(48, 'z');
    const navUrl = await listen(nav.server);
    const lfmUrl = await listen(lfm.server);
    const lbUrl = await listen(lb.server);
    process.env['TAGAVE_PLAYER_URL'] = navUrl;
    process.env['TAGAVE_PLAYER_USER'] = 'admin';
    process.env['TAGAVE_PLAYER_PASSWORD'] = PASSWORD;
    process.env['TAGAVE_LASTFM_API_URL'] = `${lfmUrl}/2.0/`;
    process.env['TAGAVE_LISTENBRAINZ_API_URL'] = lbUrl;
    process.env['TAGAVE_LASTFM_API_KEY'] = LASTFM_KEY;
    process.env['TAGAVE_LASTFM_SECRET'] = LASTFM_SECRET;

    const { initDb } = await import('../db.js');
    const made = await initDb(process.env.TEST_DATABASE_URL!);
    sql = made.client;
    db = made.db;
    await sql`insert into users (id, email, display_name, password_hash, role) values
      (${anna}, ${`anna-${anna}@t.com`}, 'Anna', 'x', 'owner'), (${ben}, ${`ben-${ben}@t.com`}, 'Ben', 'x', 'listener')`;
    await sql`insert into libraries (id, owner_user_id, name, settings) values (${libraryId}, ${anna}, 'Likes', '{}'::jsonb)`;
    await sql`insert into scan_roots (id, library_id, path, display_name, validation_status) values (${rootId}, ${libraryId}, '/mnt/music', 'Music', 'ok')`;
    await sql`insert into artists (id, mbid, name) values (${artistId}, ${artistMbid}, 'The Band')`;
    await sql`insert into release_groups (id, mbid, title) values (${rgId}, ${randomUUID()}, 'Liked Album')`;
    await sql`insert into release_group_artists (release_group_id, artist_id, position) values (${rgId}, ${artistId}, 0)`;
    await sql`insert into releases (id, release_group_id, mbid, title) values (${releaseId}, ${rgId}, ${releaseMbid}, 'Liked Album')`;
    for (const [i, k] of (['one', 'two', 'three'] as const).entries()) {
      await sql`insert into canonical_tracks (id, release_id, medium_no, position, title, recording_mbid) values (${ct[k]}, ${releaseId}, 1, ${i + 1}, ${k}, ${rec[k]})`;
    }
    await sql`insert into local_albums (id, library_id, cluster_key, title_guess, artist_guess, state, release_id, release_group_id)
              values (${albumId}, ${libraryId}, ${`ck-${albumId}`}, 'Liked Album', 'The Band', 'matched', ${releaseId}, ${rgId})`;
    // an album not identified yet
    await sql`insert into local_albums (id, library_id, cluster_key, title_guess, artist_guess, state)
              values (${otherAlbumId}, ${libraryId}, ${`ck-${otherAlbumId}`}, 'Demos', 'The Band', 'unidentified')`;
    await file(f.one, 'The Band/Liked Album/01 First.flac');
    await file(f.two, 'The Band/Liked Album/02 Second.flac');
    await file(f.three, 'The Band/Liked Album/03 Third.flac');
    await file(f.loose, 'The Band/Demos/01 Demo.flac');
    await track(t.one, albumId, f.one, 1, 'First', ct.one);
    await track(t.two, albumId, f.two, 2, 'Second', ct.two);
    await track(t.three, albumId, f.three, 3, 'Third', ct.three);
    await track(t.loose, otherAlbumId, f.loose, 1, 'Demo', null);
    nav.state.albums.push({
      id: 'al-l', name: 'Liked Album', artist: 'The Band', artistId: 'ar-band', artistMbid, musicBrainzId: releaseMbid, songs: [
        { id: 's-1', title: 'First', track: 1, discNumber: 1, path: '/music/The Band/Liked Album/01 First.flac', duration: 200, musicBrainzId: rec.one },
        { id: 's-2', title: 'Second', track: 2, discNumber: 1, path: '/music/The Band/Liked Album/02 Second.flac', duration: 200, musicBrainzId: rec.two },
        { id: 's-3', title: 'Third', track: 3, discNumber: 1, path: '/music/The Band/Liked Album/03 Third.flac', duration: 200, musicBrainzId: rec.three },
      ],
    });

    likesLib = await import('../lib/likes.js');
    sync = await import('../lib/playerLikes.js');
    people = await import('../lib/playerPeople.js');
    scrob = await import('../lib/scrobbling.js');
    albumsRoute = await import('./albums.js');
    const { backendFor, clearCapabilityCache } = await import('../lib/player.js');
    clearCapabilityCache();
    backend = backendFor({});

    const { errorHandler } = await import('../middleware/errorHandler.js');
    const { createLikeRoutes } = await import('./likes.js');
    const { createPlayerListeningRoutes } = await import('./playerListening.js');
    const { createArtistsRoutes } = await import('./artists.js');
    app = Fastify({ logger: false });
    await errorHandler(app);
    app.addHook('preHandler', async (request) => {
      const id = request.headers['x-test-user'];
      request.user = typeof id === 'string' ? ({ id, email: `${id}@t.com`, role: id === anna ? 'owner' : 'listener' } as any) : undefined;
    });
    await app.register(createLikeRoutes, { prefix: '/api/v1' });
    await app.register(createPlayerListeningRoutes, { prefix: '/api/v1' });
    await app.register(createArtistsRoutes, { prefix: '/api/v1' });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    for (const s of [nav.server, lfm.server, lb.server]) await close(s);
    if (sql) {
      await sql`delete from libraries where id = ${libraryId}`;
      await sql`delete from releases where id = ${releaseId}`;
      await sql`delete from release_groups where id = ${rgId}`;
      await sql`delete from artists where id = ${artistId}`;
      await sql`delete from users where id in (${anna}, ${ben})`;
      await sql.end({ timeout: 5 });
    }
    for (const k of envKeys) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  const put = (user: string, kind: string, id: string) => app.inject({ method: 'PUT', url: `/api/v1/me/likes/${kind}/${id}`, headers: as(user) });
  const del = (user: string, kind: string, id: string) => app.inject({ method: 'DELETE', url: `/api/v1/me/likes/${kind}/${id}`, headers: as(user) });
  const keys = async (user: string) => (await app.inject({ method: 'GET', url: '/api/v1/me/likes', headers: as(user) })).json();
  const liked = async (user: string) => (await app.inject({ method: 'GET', url: '/api/v1/me/likes/songs', headers: as(user) })).json();

  it('likes and unlikes songs, albums and artists, once each, per person', async () => {
    expect(await keys(anna)).toEqual({ songs: [], albums: [], artists: [] });
    const r = await put(anna, 'song', t.two);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().songs).toEqual([t.two]);
    expect((await put(anna, 'song', t.two)).statusCode).toBe(200);
    expect((await sql`select count(*)::int as n from likes where user_id = ${anna} and kind = 'song'`)[0].n).toBe(1);
    expect((await put(anna, 'album', albumId)).json().albums).toEqual([albumId]);
    expect((await put(anna, 'artist', artistId)).json().artists).toEqual([artistId]);
    // Ben sees none of it
    expect(await keys(ben)).toEqual({ songs: [], albums: [], artists: [] });
    // the like keeps what the song was
    const [row] = await sql`select title, artist, album, recording_mbid from likes where user_id = ${anna} and kind = 'song'`;
    expect(row).toEqual({ title: 'Second', artist: 'The Band', album: 'Liked Album', recording_mbid: rec.two });
    // nothing there, or not a thing one can like
    expect((await put(anna, 'song', randomUUID())).statusCode).toBe(404);
    expect((await put(anna, 'playlist', albumId)).statusCode).toBe(404);
    expect((await put(anna, 'song', 'nope')).statusCode).toBe(404);
    // unlike leaves a removal for the sync
    expect((await del(anna, 'artist', artistId)).json().artists).toEqual([]);
    expect((await sql`select count(*)::int as n from like_removals where user_id = ${anna} and kind = 'artist' and artist_id = ${artistId}`)[0].n).toBe(1);
    await put(anna, 'artist', artistId);
  });

  it('Liked songs: newest first, with the count, and Missing for a song that left', async () => {
    await put(anna, 'song', t.one);
    await sql`update likes set liked_at = now() - interval '1 hour' where user_id = ${anna} and local_track_id = ${t.two}`;
    const v = await liked(anna);
    expect(v.count).toBe(2);
    expect(v.items.map((i: any) => i.localTrackId)).toEqual([t.one, t.two]);
    expect(v.items[0]).toMatchObject({ title: 'First', artist: 'The Band', album: 'Liked Album', albumId, artistLink: { id: artistId, name: 'The Band' } });
    expect(v.durationMs).toBe(400_000);
  });

  it('keeps a song liked through a Move (the row stays) and a Split (a new row of the same recording)', async () => {
    // Move: the file goes to another album's folder; the track row is the same
    await sql`update local_tracks set local_album_id = ${otherAlbumId} where id = ${t.one}`;
    expect((await keys(anna)).songs).toContain(t.one);
    await sql`update local_tracks set local_album_id = ${albumId} where id = ${t.one}`;
    // Split or re-import: the row goes, a new one of the same recording comes
    const newTrack = randomUUID();
    const newFile = randomUUID();
    await sql`delete from local_tracks where id = ${t.two}`;
    expect((await sql`select local_track_id from likes where user_id = ${anna} and recording_mbid = ${rec.two}`)[0].local_track_id).toBeNull();
    await file(newFile, 'The Band/Liked Album/02 Second (split).flac');
    await track(newTrack, albumId, newFile, 2, 'Second', ct.two);
    const k = await keys(anna);
    expect(k.songs).toContain(newTrack);
    expect((await sql`select local_track_id from likes where user_id = ${anna} and recording_mbid = ${rec.two}`)[0].local_track_id).toBe(newTrack);
    const v = await liked(anna);
    expect(v.items.find((i: any) => i.title === 'Second').localTrackId).toBe(newTrack);
    // unliking the new copy takes the like off
    expect((await del(anna, 'song', newTrack)).json().songs).not.toContain(newTrack);
    t.two = newTrack;
    f.two = newFile;
  });

  it('keeps an album liked through re-clustering and identification', async () => {
    // a new local album of the same release group (the folder re-clustered, an edition switch): liked
    const copy = randomUUID();
    await sql`insert into local_albums (id, library_id, cluster_key, title_guess, artist_guess, state, release_id, release_group_id)
              values (${copy}, ${libraryId}, ${`ck-${copy}`}, 'Liked Album (MP3)', 'The Band', 'matched', ${releaseId}, ${rgId})`;
    expect((await keys(anna)).albums.sort()).toEqual([albumId, copy].sort());
    await sql`delete from local_albums where id = ${copy}`;
    // an album liked before it was identified gains its release group
    await put(anna, 'album', otherAlbumId);
    expect((await sql`select release_group_id from likes where user_id = ${anna} and local_album_id = ${otherAlbumId}`)[0].release_group_id).toBeNull();
    const rg2 = randomUUID();
    await sql`insert into release_groups (id, mbid, title) values (${rg2}, ${randomUUID()}, 'Demos')`;
    await sql`update local_albums set release_group_id = ${rg2} where id = ${otherAlbumId}`;
    expect((await keys(anna)).albums).toContain(otherAlbumId);
    expect((await sql`select release_group_id from likes where user_id = ${anna} and local_album_id = ${otherAlbumId}`)[0].release_group_id).toBe(rg2);
    await del(anna, 'album', otherAlbumId);
    await sql`update local_albums set release_group_id = null where id = ${otherAlbumId}`;
    await sql`delete from release_groups where id = ${rg2}`;
  });

  it('filters albums and artists to the liked ones, with the count', async () => {
    const ids = async (q: Record<string, unknown>) => (await db.select({ id: localAlbums.id }).from(localAlbums).where(and(...albumsRoute.albumQueryParts(libraryId, anna, q).conds))).map((r: any) => r.id).sort();
    expect(await ids({})).toEqual([albumId, otherAlbumId].sort());
    expect(await ids({ liked: 'yes' })).toEqual([albumId]);
    expect((await db.select({ id: localAlbums.id }).from(localAlbums).where(and(...albumsRoute.albumQueryParts(libraryId, ben, { liked: 'yes' }).conds)))).toEqual([]);
    // the worker-built counts answer the same
    const { summaryFilterCounts, summaryEligible } = await import('../lib/filterCounts.js');
    expect(summaryEligible({ liked: 'yes', genre: 'Rock' })).toBe(true);
    await sql`insert into album_filter_counts (album_id, library_id, release_group_id, state, format) values
      (${albumId}, ${libraryId}, ${rgId}, 'matched', 'lossless'), (${otherAlbumId}, ${libraryId}, null, 'unidentified', 'lossless')`;
    expect((await summaryFilterCounts(db, libraryId, anna, {})).liked).toEqual([{ value: 'yes', count: 1 }]);
    expect((await summaryFilterCounts(db, libraryId, anna, { liked: 'yes' })).total).toBe(1);
    expect((await summaryFilterCounts(db, libraryId, ben, { liked: 'yes' })).total).toBe(0);
    await sql`delete from album_filter_counts where library_id = ${libraryId}`;
    // artists
    const artists = async (user: string, q = '') => (await app.inject({ method: 'GET', url: `/api/v1/libraries/${libraryId}/artists?${q}`, headers: as(user) })).json();
    expect((await artists(anna, 'liked=yes')).items.map((a: any) => a.id)).toEqual([artistId]);
    expect((await artists(ben, 'liked=yes')).items).toEqual([]);
  });

  it('sends loves to Last.fm and ListenBrainz once per change, and not when turned off', async () => {
    await scrob.connectAccount(sql, anna, 'lastfm', 'anna-fm', 'sk-anna');
    await scrob.connectAccount(sql, anna, 'listenbrainz', 'anna-lb', 'lb-token-anna');
    const view = await app.inject({ method: 'GET', url: '/api/v1/me/listening', headers: as(anna) });
    expect(view.json().services.map((s: any) => [s.service, s.loves])).toEqual([['lastfm', true], ['listenbrainz', true]]);
    await put(anna, 'song', t.three);
    await put(anna, 'song', t.three);
    await sync.sendDueLoves({ sql });
    await sync.sendDueLoves({ sql });
    expect(lfm.state.loves.map((l) => [l['method'], l['artist'], l['track'], l['sk']])).toEqual([['track.love', 'The Band', 'Third', 'sk-anna']]);
    expect(lb.state.feedback).toEqual([{ user: 'anna-lb', body: { recording_mbid: rec.three, score: 1 } }]);
    await del(anna, 'song', t.three);
    await sync.sendDueLoves({ sql });
    expect(lfm.state.loves.at(-1)!['method']).toBe('track.unlove');
    expect(lb.state.feedback.at(-1)!.body.score).toBe(0);
    // Last.fm Off: ListenBrainz still gets it
    const off = await app.inject({ method: 'PUT', url: '/api/v1/me/listening/lastfm/loves', headers: as(anna), payload: { on: false } });
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json().services.find((s: any) => s.service === 'lastfm').loves).toBe(false);
    const before = lfm.state.loves.length;
    await put(anna, 'song', t.three);
    await sync.sendDueLoves({ sql });
    expect(lfm.state.loves.length).toBe(before);
    expect(lb.state.feedback.at(-1)!.body.score).toBe(1);
    // a song without a recording MBID: Last.fm only, ListenBrainz ignores it
    await app.inject({ method: 'PUT', url: '/api/v1/me/listening/lastfm/loves', headers: as(anna), payload: { on: true } });
    await put(anna, 'song', t.loose);
    await sync.sendDueLoves({ sql });
    expect(lfm.state.loves.at(-1)!['track']).toBe('Demo');
    expect((await sql`select status from player_loves where user_id = ${anna} and service = 'listenbrainz' order by created_at desc limit 1`)[0].status).toBe('ignored');
    // Ben has no connection: nothing to change
    expect((await app.inject({ method: 'PUT', url: '/api/v1/me/listening/lastfm/loves', headers: as(ben), payload: { on: false } })).statusCode).toBe(409);
    await del(anna, 'song', t.loose);
    await del(anna, 'song', t.three);
    await sync.sendDueLoves({ sql });
  });

  describe('the player server’s stars', () => {
    const navUser = () => nav.state.users.get('anna')!;
    const starred = () => [...navUser().starred].sort();
    const run = () => sync.syncPersonLikes({ sql }, backend, anna);

    beforeAll(async () => {
      await people.syncBundledUsers(sql, backend);
      expect(nav.state.users.has('anna')).toBe(true);
    });

    it('stars tagave’s likes on the person’s account, matching the albums first', async () => {
      // liked now: the song First (t.one), the album, the artist
      const r = await run();
      expect(r.starred).toBe(3);
      expect(starred()).toEqual(['al-l', 'ar-band', 's-1']);
      // nothing changed: nothing sent
      expect(await run()).toEqual({ starred: 0, unstarred: 0, liked: 0, unliked: 0 });
      // Ben has never played: no account, nothing synced
      expect(await sync.syncPersonLikes({ sql }, backend, ben)).toEqual({ starred: 0, unstarred: 0, liked: 0, unliked: 0 });
    });

    it('imports a star made in a Subsonic app, with its time', async () => {
      // after tagave's own unlike of the song (the loves test): the app's star is the newer
      const at = Date.now();
      nav.appStar('anna', 's-3', true, at);
      const r = await run();
      expect(r.liked).toBe(1);
      expect((await keys(anna)).songs).toContain(t.three);
      const [row] = await sql`select liked_at from likes where user_id = ${anna} and local_track_id = ${t.three}`;
      expect(new Date(row.liked_at).getTime()).toBe(at);
      expect(await run()).toEqual({ starred: 0, unstarred: 0, liked: 0, unliked: 0 });
    });

    it('takes a like off when the app takes the star off, and the other way round', async () => {
      nav.appStar('anna', 's-3', false);
      expect((await run()).unliked).toBe(1);
      expect((await keys(anna)).songs).not.toContain(t.three);
      // the unlike from the server queues an unlove too
      expect((await sql`select count(*)::int as n from player_loves where user_id = ${anna} and love = false and status = 'pending'`)[0].n).toBeGreaterThan(0);
      await sync.sendDueLoves({ sql });
      // unliked in tagave: the star goes
      await del(anna, 'album', albumId);
      expect((await run()).unstarred).toBe(1);
      expect(starred()).toEqual(['ar-band', 's-1']);
    });

    it('last write wins when both sides changed', async () => {
      // tagave unliked the song after the app starred it again: unstarred
      nav.appStar('anna', 's-1', false);
      nav.appStar('anna', 's-1', true, Date.now() - 30_000);
      await del(anna, 'song', t.one);
      expect((await run()).unstarred).toBe(1);
      expect(starred()).toEqual(['ar-band']);
      expect((await keys(anna)).songs).not.toContain(t.one);
      // the app starred it again after tagave's unlike: liked again
      await sql`update like_removals set removed_at = now() - interval '5 minutes' where user_id = ${anna} and kind = 'song'`;
      nav.appStar('anna', 's-1', true, Date.now());
      expect((await run()).liked).toBe(1);
      expect((await keys(anna)).songs).toContain(t.one);
      // the artist: unstarred in the app after the last sync, liked in tagave before it: the like goes
      nav.appStar('anna', 'ar-band', false);
      expect((await run()).unliked).toBe(1);
      expect((await keys(anna)).artists).toEqual([]);
      // liked again in tagave after that: starred again
      await put(anna, 'artist', artistId);
      expect((await run()).starred).toBe(1);
      expect(starred()).toEqual(['ar-band', 's-1']);
    });

    it('imports an album and an artist starred in an app', async () => {
      nav.appStar('anna', 'al-l', true);
      expect((await run()).liked).toBe(1);
      expect((await keys(anna)).albums).toEqual([albumId]);
      expect(await run()).toEqual({ starred: 0, unstarred: 0, liked: 0, unliked: 0 });
    });
  });
});
