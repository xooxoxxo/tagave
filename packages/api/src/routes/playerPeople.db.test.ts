/**
 * The player per person, against the test database and fakes of Navidrome,
 * Last.fm and ListenBrainz: one Navidrome account per person (made, locked,
 * unlocked, phone password), web plays and phone-app plays becoming plays
 * exactly once, album listens, scrobbles sent exactly once per service with
 * retries, now playing, and ratings pushed per person.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { close, fakeLastfm, fakeListenbrainz, fakeNavidrome, listen } from '../testkit/playerFakes.js';

vi.mock('../boss.js', () => ({ getBoss: async () => ({ send: async () => 'job' }) }));

const PASSWORD = 'nav-admin-pw';
const LASTFM_KEY = 'a'.repeat(32);
const LASTFM_SECRET = 'b'.repeat(32);

describe.skipIf(!process.env.TEST_DATABASE_URL)('the player per person', () => {
  let app: FastifyInstance;
  let sql: any;
  const nav = fakeNavidrome(PASSWORD);
  const lfm = fakeLastfm(LASTFM_KEY, LASTFM_SECRET);
  const lb = fakeListenbrainz({ 'lb-token-anna': 'anna-lb', 'lb-token-ben': 'ben-lb' });
  let navUrl = '';
  const anna = randomUUID();
  const ben = randomUUID();
  const libraryId = randomUUID();
  const rootId = randomUUID();
  const albumId = randomUUID();
  const rgId = randomUUID();
  const releaseId = randomUUID();
  const releaseMbid = randomUUID();
  const t = { one: randomUUID(), two: randomUUID(), three: randomUUID() };
  const f = { one: randomUUID(), two: randomUUID(), three: randomUUID() };
  const as = (user: string, role = 'listener') => ({ 'x-test-user': user, 'x-test-role': role });
  const envKeys = ['TAGAVE_PLAYER_URL', 'TAGAVE_PLAYER_USER', 'TAGAVE_PLAYER_PASSWORD', 'APP_SECRET', 'TAGAVE_LASTFM_API_URL', 'TAGAVE_LASTFM_AUTH_URL', 'TAGAVE_LISTENBRAINZ_API_URL', 'PUBLIC_URL', 'TAGAVE_LASTFM_API_KEY', 'TAGAVE_LASTFM_SECRET'] as const;
  const savedEnv: Record<string, string | undefined> = {};
  let lib: typeof import('../lib/playerSync.js');
  let plays: typeof import('../lib/playerPlays.js');
  let people: typeof import('../lib/playerPeople.js');
  let scrob: typeof import('../lib/scrobbling.js');
  let ratings: typeof import('../lib/playerRatings.js');
  let backend: any;
  const opts = () => ({ sql });

  beforeAll(async () => {
    for (const k of envKeys) savedEnv[k] = process.env[k];
    process.env['APP_SECRET'] = 'test-app-secret-'.padEnd(48, 'y');
    navUrl = await listen(nav.server);
    const lfmUrl = await listen(lfm.server);
    const lbUrl = await listen(lb.server);
    process.env['TAGAVE_PLAYER_URL'] = navUrl;
    process.env['TAGAVE_PLAYER_USER'] = 'admin';
    process.env['TAGAVE_PLAYER_PASSWORD'] = PASSWORD;
    process.env['TAGAVE_LASTFM_API_URL'] = `${lfmUrl}/2.0/`;
    process.env['TAGAVE_LASTFM_AUTH_URL'] = `${lfmUrl}/api/auth/`;
    process.env['TAGAVE_LISTENBRAINZ_API_URL'] = lbUrl;
    process.env['PUBLIC_URL'] = 'http://localhost:3100';
    delete process.env['TAGAVE_LASTFM_API_KEY'];
    delete process.env['TAGAVE_LASTFM_SECRET'];

    const { initDb } = await import('../db.js');
    sql = (await initDb(process.env.TEST_DATABASE_URL!)).client;
    await sql`insert into users (id, email, display_name, password_hash, role) values
      (${anna}, ${`anna-${anna}@t.com`}, 'Anna Ö', 'x', 'owner'), (${ben}, ${`ben-${ben}@t.com`}, 'Ben', 'x', 'owner')`;
    await sql`insert into libraries (id, owner_user_id, name, settings) values (${libraryId}, ${anna}, 'People', '{}'::jsonb)`;
    await sql`insert into scan_roots (id, library_id, path, display_name, validation_status) values (${rootId}, ${libraryId}, '/mnt/music', 'Music', 'ok')`;
    await sql`insert into release_groups (id, mbid, title) values (${rgId}, ${randomUUID()}, 'People Album')`;
    await sql`insert into releases (id, release_group_id, mbid, title) values (${releaseId}, ${rgId}, ${releaseMbid}, 'People Album')`;
    await sql`insert into local_albums (id, library_id, cluster_key, title_guess, artist_guess, state, release_id, release_group_id)
              values (${albumId}, ${libraryId}, ${`ck-${albumId}`}, 'People Album', 'The Band', 'matched', ${releaseId}, ${rgId})`;
    const file = (id: string, rel: string) => sql`insert into audio_files (id, library_id, scan_root_id, rel_path, container, codec, lossless, duration_ms, status)
      values (${id}, ${libraryId}, ${rootId}, ${rel}, 'flac', 'FLAC', true, 200000, 'present')`;
    await file(f.one, 'The Band/People Album/01 First.flac');
    await file(f.two, 'The Band/People Album/02 Second.flac');
    await file(f.three, 'The Band/People Album/03 Third.flac');
    const track = (id: string, fileId: string, no: number, title: string) => sql`insert into local_tracks (id, local_album_id, audio_file_id, disc_no, track_no, title_guess, artist_guess, duration_ms, origin)
      values (${id}, ${albumId}, ${fileId}, 1, ${no}, ${title}, 'The Band', 200000, 'file')`;
    await track(t.one, f.one, 1, 'First');
    await track(t.two, f.two, 2, 'Second');
    await track(t.three, f.three, 3, 'Third');
    nav.state.albums.push({
      id: 'al-p', name: 'People Album', artist: 'The Band', musicBrainzId: releaseMbid, songs: [
        { id: 's-1', title: 'First', track: 1, discNumber: 1, path: '/music/The Band/People Album/01 First.flac', duration: 200 },
        { id: 's-2', title: 'Second', track: 2, discNumber: 1, path: '/music/The Band/People Album/02 Second.flac', duration: 200 },
        { id: 's-3', title: 'Third', track: 3, discNumber: 1, path: '/music/The Band/People Album/03 Third.flac', duration: 200 },
      ],
    });

    lib = await import('../lib/playerSync.js');
    plays = await import('../lib/playerPlays.js');
    people = await import('../lib/playerPeople.js');
    scrob = await import('../lib/scrobbling.js');
    ratings = await import('../lib/playerRatings.js');
    const { backendFor, clearCapabilityCache } = await import('../lib/player.js');
    clearCapabilityCache();
    backend = backendFor({});

    const { errorHandler } = await import('../middleware/errorHandler.js');
    const { createPlayerRoutes } = await import('./player.js');
    const { createPlayerListeningRoutes } = await import('./playerListening.js');
    app = Fastify({ logger: false });
    await errorHandler(app);
    app.addHook('preHandler', async (request) => {
      const id = request.headers['x-test-user'];
      request.user = typeof id === 'string' ? ({ id, email: `${id}@t.com`, role: request.headers['x-test-role'] } as any) : undefined;
    });
    await app.register(createPlayerRoutes, { prefix: '/api/v1' });
    await app.register(createPlayerListeningRoutes, { prefix: '/api/v1' });
    await app.ready();
  });

  beforeEach(() => {
    plays.clearNowPlayingMemory();
  });

  afterAll(async () => {
    await app?.close();
    for (const s of [nav.server, lfm.server, lb.server]) await close(s);
    if (sql) {
      await sql`delete from libraries where id = ${libraryId}`;
      await sql`delete from releases where id = ${releaseId}`;
      await sql`delete from release_groups where id = ${rgId}`;
      await sql`delete from users where id in (${anna}, ${ben})`;
      await sql.end({ timeout: 5 });
    }
    for (const k of envKeys) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  const event = (user: string, kind: string, track: string, playedMs: number, queueId = randomUUID()) =>
    app.inject({ method: 'POST', url: '/api/v1/player/events', headers: as(user), payload: { kind, localTrackId: track, queueId, playedMs, positionMs: playedMs } });
  const playsOf = (user: string) => sql`select * from player_plays where user_id = ${user} order by started_at, created_at`;

  it('makes one Navidrome account per person, with a sealed random password, and keeps them in step', async () => {
    const r = await people.syncBundledUsers(sql, backend);
    expect(r.created).toBeGreaterThanOrEqual(2);
    const rows = await sql`select user_id, username, password_sealed, source, state from player_users where user_id in (${anna}, ${ben}) order by username`;
    expect(rows.map((x: any) => x.username)).toEqual(['anna-o', 'ben']);
    for (const x of rows) {
      expect(x.password_sealed).toMatch(/^enc:v1:/);
      expect(x.source).toBe('managed');
      expect(nav.state.users.has(x.username)).toBe(true);
      expect(nav.state.users.get(x.username)!.isAdmin).toBe(false);
    }
    // running again changes nothing
    expect((await people.syncBundledUsers(sql, backend)).created).toBe(0);
    // a disabled person is locked out (a new password nobody knows), then let back in
    const before = nav.state.users.get('ben')!.password;
    await sql`update users set disabled_at = now() where id = ${ben}`;
    expect((await people.syncBundledUsers(sql, backend)).locked).toBe(1);
    expect(nav.state.users.get('ben')!.password).not.toBe(before);
    const locked = await app.inject({ method: 'GET', url: `/api/v1/player/stream/${t.one}`, headers: as(ben) });
    expect(locked.statusCode).toBe(403);
    await sql`update users set disabled_at = null where id = ${ben}`;
    expect((await people.syncBundledUsers(sql, backend)).unlocked).toBe(1);
    expect((await sql`select state from player_users where user_id = ${ben}`)[0].state).toBe('active');
  });

  it('lets a person set a phone-app password, never shows it, and the server takes it', async () => {
    const short = await app.inject({ method: 'PUT', url: '/api/v1/me/listening/phone-password', headers: as(ben), payload: { password: 'short' } });
    expect(short.statusCode).toBe(400);
    const res = await app.inject({ method: 'PUT', url: '/api/v1/me/listening/phone-password', headers: as(ben), payload: { password: 'ben phone password 1' } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().account).toEqual({ kind: 'bundled', username: 'ben', phonePassword: true, serverScrobbles: false, state: 'active', lastError: null });
    expect(res.body).not.toContain('ben phone password 1');
    expect(nav.state.users.get('ben')!.password).toBe('ben phone password 1');
    const view = await app.inject({ method: 'GET', url: '/api/v1/me/listening', headers: as(ben) });
    expect(view.body).not.toContain('ben phone password 1');
    expect(view.json()).toMatchObject({ playerInstalled: true, account: { username: 'ben', phonePassword: true } });
  });

  it('connects Last.fm through its web auth and ListenBrainz with a checked token', async () => {
    // the owner first: the API key and secret are checked with Last.fm and stored sealed
    const listener = await app.inject({ method: 'PUT', url: `/api/v1/libraries/${libraryId}/player/scrobbling`, headers: as(ben), payload: { apiKey: LASTFM_KEY, secret: LASTFM_SECRET } });
    expect(listener.statusCode).toBe(403);
    const wrong = await app.inject({ method: 'PUT', url: `/api/v1/libraries/${libraryId}/player/scrobbling`, headers: as(anna, 'owner'), payload: { apiKey: LASTFM_KEY, secret: 'c'.repeat(32) } });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().detail).toMatch(/shared secret/);
    const noApp = await app.inject({ method: 'POST', url: '/api/v1/me/listening/lastfm/start', headers: as(anna) });
    expect(noApp.statusCode).toBe(409);
    const saved = await app.inject({ method: 'PUT', url: `/api/v1/libraries/${libraryId}/player/scrobbling`, headers: as(anna, 'owner'), payload: { apiKey: LASTFM_KEY, secret: LASTFM_SECRET } });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toEqual({ lastfm: { configured: true, source: 'settings', apiKeyHint: 'aaaa' }, listenbrainz: { available: true } });
    const [row] = await sql`select settings from libraries where id = ${libraryId}`;
    expect(row.settings.lastfmApiKey).toMatch(/^enc:v1:/);
    expect(JSON.stringify(row.settings)).not.toContain(LASTFM_SECRET);

    const start = await app.inject({ method: 'POST', url: '/api/v1/me/listening/lastfm/start', headers: as(anna) });
    const url = new URL(start.json().url);
    expect(url.searchParams.get('api_key')).toBe(LASTFM_KEY);
    const cb = new URL(url.searchParams.get('cb')!);
    expect(cb.origin).toBe('http://localhost:3100');
    // Last.fm sends the browser back with a token; a state made for someone else is refused
    const forged = await app.inject({ method: 'GET', url: `${cb.pathname}${cb.search}&token=good-token`, headers: as(ben) });
    expect(forged.headers.location).toBe('/settings/listening?lastfm=expired');
    const back = await app.inject({ method: 'GET', url: `${cb.pathname}${cb.search}&token=good-token`, headers: as(anna) });
    expect(back.statusCode).toBe(303);
    expect(back.headers.location).toBe('/settings/listening?lastfm=connected');
    const [acct] = await sql`select account_name, secret_sealed from scrobble_accounts where user_id = ${anna} and service = 'lastfm'`;
    expect(acct.account_name).toBe('anna-fm');
    expect(acct.secret_sealed).toMatch(/^enc:v1:/);

    const badLb = await app.inject({ method: 'POST', url: '/api/v1/me/listening/listenbrainz', headers: as(anna), payload: { token: 'not-a-real-token' } });
    expect(badLb.statusCode).toBe(400);
    const lbOk = await app.inject({ method: 'POST', url: '/api/v1/me/listening/listenbrainz', headers: as(anna), payload: { token: 'lb-token-anna' } });
    expect(lbOk.statusCode, lbOk.body).toBe(200);
    expect(lbOk.body).not.toContain('lb-token-anna');
    expect(lbOk.json().services.map((s: any) => [s.service, s.connected, s.accountName])).toEqual([['lastfm', true, 'anna-fm'], ['listenbrainz', true, 'anna-lb']]);
    // Ben: ListenBrainz only
    expect((await app.inject({ method: 'POST', url: '/api/v1/me/listening/listenbrainz', headers: as(ben), payload: { token: 'lb-token-ben' } })).statusCode).toBe(200);
  });

  it('turns web-player events into plays once, sends now playing, and reports heard plays as the person', async () => {
    // Anna plays two tracks through; a third is skipped after 10 s
    const q = randomUUID();
    await event(anna, 'now_playing', t.one, 0, q);
    await event(anna, 'completed', t.one, 199_000, q);
    await event(anna, 'completed', t.two, 150_000, q);
    await event(anna, 'skipped', t.three, 10_000, q);
    // songs are matched once the album is queued
    expect((await app.inject({ method: 'GET', url: `/api/v1/player/albums/${albumId}/queue`, headers: as(anna) })).statusCode).toBe(200);
    await lib.runPlayerFastSync(opts());
    const rows = await playsOf(anna);
    expect(rows.map((r: any) => [r.title, r.source, r.heard, r.scrobbles])).toEqual([
      ['First', 'web', true, true], ['Second', 'web', true, true], ['Third', 'web', false, false],
    ]);
    expect(rows[0]).toMatchObject({ artist: 'The Band', album: 'People Album', release_mbid: releaseMbid, local_album_id: albumId });
    // reported to Navidrome as Anna, with the play's start time; her counts there are hers
    const submitted = nav.state.scrobbles.filter((s) => s.submission);
    expect(submitted.map((s) => [s.user, s.id])).toEqual([['anna-o', 's-1'], ['anna-o', 's-2']]);
    expect(submitted[0]!.time).toBe(new Date(rows[0].started_at).getTime());
    expect(nav.state.users.get('anna-o')!.plays.get('s-1')!.count).toBe(1);
    expect(nav.state.users.get('ben')!.plays.size).toBe(0);
    // now playing went to both of Anna's services
    expect(lfm.state.nowPlaying.map((n) => n['track'])).toEqual(['First']);
    expect(lb.state.listens.filter((l) => l.body.listen_type === 'playing_now').map((l) => l.user)).toEqual(['anna-lb']);
    // processing the same events again adds nothing
    await sql`update player_events set processed_at = null where user_id = ${anna}`;
    await lib.runPlayerFastSync(opts());
    expect(await playsOf(anna)).toHaveLength(3);
    expect(nav.state.scrobbles.filter((s) => s.submission)).toHaveLength(2);
  });

  it('makes one album listen from half the tracks within six hours, and never a second from the same plays', async () => {
    const listens = await sql`select * from player_listens where user_id = ${anna}`;
    expect(listens).toHaveLength(1);
    expect(listens[0]).toMatchObject({ local_album_id: albumId, release_id: releaseId, tracks_heard: 2, tracks_total: 3 });
    const [row] = await sql`select release_group_id, release_id, format, source from listens where id = ${listens[0].listen_id}`;
    expect(row).toEqual({ release_group_id: rgId, release_id: releaseId, format: 'digital', source: 'player' });
    expect(await plays.deriveListens(sql, anna)).toBe(0);
    expect(await sql`select 1 from listens where user_id = ${anna} and release_group_id = ${rgId}`).toHaveLength(1);
    // the album's listens list shows it (per person)
    expect(await sql`select 1 from listens where user_id = ${ben}`).toHaveLength(0);
  });

  it('sends each scrobble once per service, and only plays that count', async () => {
    await lib.runPlayerFastSync(opts());
    expect(lfm.state.scrobbles.map((s) => [s['track'], s['artist'], s['album'], s['sk']])).toEqual([
      ['First', 'The Band', 'People Album', 'sk-anna'], ['Second', 'The Band', 'People Album', 'sk-anna'],
    ]);
    const lbSingles = lb.state.listens.filter((l) => l.body.listen_type === 'single');
    expect(lbSingles.map((l) => [l.user, (l.body.payload[0] as any).track_metadata.track_name])).toEqual([['anna-lb', 'First'], ['anna-lb', 'Second']]);
    expect((lbSingles[0]!.body.payload[0] as any).track_metadata.additional_info.release_mbid).toBe(releaseMbid);
    // again: nothing new
    await lib.runPlayerFastSync(opts());
    await scrob.sendDueScrobbles({ sql });
    expect(lfm.state.scrobbles).toHaveLength(2);
    expect(lb.state.listens.filter((l) => l.body.listen_type === 'single')).toHaveLength(2);
    const statuses = await sql`select s.service, s.status from player_scrobbles s join player_plays p on p.id = s.play_id where p.user_id = ${anna} order by s.service`;
    expect(statuses.map((s: any) => s.status)).toEqual(['sent', 'sent', 'sent', 'sent']);
  });

  it('counts plays from a phone app through Navidrome once, separately per person, and scrobbles them once', async () => {
    // the first poll of a person only records their counts
    await plays.pollPerson(plays_deps(), backend, ben);
    const benBefore = nav.state.users.get('ben')!.plays.size;
    expect(benBefore).toBe(0);
    // Ben plays the whole album on his phone; Anna's tagave plays are already counted
    ['s-1', 's-2', 's-3'].forEach((id, i) => nav.phonePlay('ben', id, Date.now() - 600_000 + i * 200_000));
    await plays.pollPerson(plays_deps(), backend, anna);
    expect((await playsOf(anna)).filter((p: any) => p.source === 'server')).toHaveLength(0);
    expect(await plays.pollPerson(plays_deps(), backend, ben)).toBe(3);
    // polling again, or the same counts seen twice, adds nothing
    expect(await plays.pollPerson(plays_deps(), backend, ben)).toBe(0);
    await sql`update player_poll_state set cursor_at = cursor_at - interval '1 hour' where user_id = ${ben}`;
    expect(await plays.pollPerson(plays_deps(), backend, ben)).toBe(0);
    const benPlays = await playsOf(ben);
    expect(benPlays.map((p: any) => [p.title, p.source, p.local_track_id])).toEqual([['First', 'server', t.one], ['Second', 'server', t.two], ['Third', 'server', t.three]]);
    expect(benPlays.map((p: any) => p.dedupe_key)).toEqual(['server:bundled:s-1:1', 'server:bundled:s-2:1', 'server:bundled:s-3:1']);
    expect(await plays.deriveListens(sql, ben)).toBe(1);
    // Ben scrobbles to his ListenBrainz only (he has no Last.fm)
    await scrob.sendDueScrobbles({ sql });
    expect(lb.state.listens.filter((l) => l.user === 'ben-lb' && l.body.listen_type === 'single')).toHaveLength(3);
    expect(lfm.state.scrobbles).toHaveLength(2);
    // Anna's web plays reported to Navidrome were not seen again as phone plays
    nav.phonePlay('anna-o', 's-3', Date.now());
    expect(await plays.pollPerson(plays_deps(), backend, anna)).toBe(1);
    const annaServer = (await playsOf(anna)).filter((p: any) => p.source === 'server');
    expect(annaServer.map((p: any) => p.title)).toEqual(['Third']);
  });

  it('retries a scrobble the service could not take, then sends it once', async () => {
    await scrob.sendDueScrobbles({ sql });
    lfm.state.failNext = 1;
    nav.phonePlay('anna-o', 's-1', Date.now());
    expect(await plays.pollPerson(plays_deps(), backend, anna)).toBe(1);
    const before = lfm.state.scrobbles.length;
    await scrob.sendDueScrobbles({ sql });
    expect(lfm.state.scrobbles.length).toBe(before);
    const [pending] = await sql`select s.status, s.attempts, s.next_attempt_at, s.last_error from player_scrobbles s join player_plays p on p.id = s.play_id
      where p.user_id = ${anna} and s.service = 'lastfm' and s.status <> 'sent'`;
    expect(pending).toMatchObject({ status: 'pending', attempts: 1, last_error: 'Service Offline' });
    expect(new Date(pending.next_attempt_at).getTime()).toBeGreaterThan(Date.now() + 30_000);
    // not due yet: nothing happens
    await scrob.sendDueScrobbles({ sql });
    expect(lfm.state.scrobbles.length).toBe(before);
    // later: sent once
    await scrob.sendDueScrobbles({ sql, now: () => Date.now() + 5 * 60_000 });
    await scrob.sendDueScrobbles({ sql, now: () => Date.now() + 60 * 60_000 });
    expect(lfm.state.scrobbles.length).toBe(before + 1);
    const view = await app.inject({ method: 'GET', url: '/api/v1/me/listening', headers: as(anna) });
    expect(view.json().services.find((s: any) => s.service === 'lastfm')).toMatchObject({ connected: true, pending: 0, lastError: null });
  });

  it('forwards a phone app’s now playing to the person’s services, once', async () => {
    nav.state.nowPlaying = [{ user: 'ben', id: 's-2', at: Date.now(), player: 'Symfonium' }, { user: 'anna-o', id: 's-1', at: Date.now(), player: 'tagave' }];
    const before = lb.state.listens.length;
    expect(await plays.forwardServerNowPlaying(plays_deps(), backend)).toBe(1);
    expect(await plays.forwardServerNowPlaying(plays_deps(), backend)).toBe(0);
    const sent = lb.state.listens.slice(before);
    expect(sent.map((l) => [l.user, l.body.listen_type, (l.body.payload[0] as any).track_metadata.track_name])).toEqual([['ben-lb', 'playing_now', 'Second']]);
  });

  it('pushes a person’s ratings and favourite tracks to their own Navidrome account', async () => {
    await sql`insert into user_reviews (library_id, user_id, release_group_id, rating, favorite_track_ids) values (${libraryId}, ${anna}, ${rgId}, 3.5, ${[t.two]})`;
    expect(await ratings.syncPersonRatings({ sql }, backend, anna)).toBe(1);
    expect(nav.state.users.get('anna-o')!.ratings.get('al-p')).toBe(4);
    expect([...nav.state.users.get('anna-o')!.starred]).toEqual(['s-2']);
    expect(nav.state.users.get('ben')!.ratings.size).toBe(0);
    // nothing changed: nothing sent
    expect(await ratings.syncPersonRatings({ sql }, backend, anna)).toBe(0);
    await sql`update user_reviews set rating = 1.5, favorite_track_ids = ${[t.three]}, updated_at = now() + interval '1 second' where user_id = ${anna}`;
    expect(await ratings.syncPersonRatings({ sql }, backend, anna)).toBe(1);
    expect(nav.state.users.get('anna-o')!.ratings.get('al-p')).toBe(2);
    expect([...nav.state.users.get('anna-o')!.starred]).toEqual(['s-3']);
    // the review deleted in tagave: the rating and stars go
    await sql`delete from user_reviews where user_id = ${anna}`;
    expect(await ratings.syncPersonRatings({ sql }, backend, anna)).toBe(1);
    expect(nav.state.users.get('anna-o')!.ratings.has('al-p')).toBe(false);
    expect(nav.state.users.get('anna-o')!.starred.size).toBe(0);
  });

  it('shows the person their plays and listens, and only theirs', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/me/listening/history', headers: as(ben) });
    const h = res.json();
    expect(h.plays.every((p: any) => p.source === 'server')).toBe(true);
    expect(h.plays).toHaveLength(3);
    expect(h.listens).toHaveLength(1);
    expect(h.plays[0].scrobbled).toEqual([{ service: 'listenbrainz', status: 'sent', error: null }]);
    expect(JSON.stringify(h)).not.toContain('anna');
  });

  it('disconnecting drops what is still waiting for that service', async () => {
    nav.phonePlay('ben', 's-1', Date.now());
    expect(await plays.pollPerson(plays_deps(), backend, ben)).toBe(1);
    const del = await app.inject({ method: 'DELETE', url: '/api/v1/me/listening/listenbrainz', headers: as(ben) });
    expect(del.statusCode).toBe(200);
    const before = lb.state.listens.length;
    await scrob.sendDueScrobbles({ sql });
    expect(lb.state.listens.length).toBe(before);
    expect((await sql`select 1 from scrobble_accounts where user_id = ${ben}`)).toHaveLength(0);
  });

  function plays_deps() {
    return lib.playsDeps(opts());
  }
});
