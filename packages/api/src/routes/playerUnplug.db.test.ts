/**
 * The player's plug/unplug round trip (the module composition rule): the
 * player is used through its real code paths (accounts on a fake Navidrome,
 * web plays → plays → listens, phone plays, scrobble connections, ratings
 * pushed, scan requests), then turned off.
 *
 *   turned off, data kept   the background loop does nothing at all and
 *                           every row stays as it was
 *   "Delete its data"       every player_* and scrobble_accounts row goes;
 *                           the core (people, the library, albums, tracks,
 *                           reviews, listens with the player's) is exactly
 *                           as before; a second purge deletes nothing
 *   + "delete play history" the player's listens go too, and only those
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { sealSecret } from '@tagave/core';
import { MODULE_DATA, PurgeRefused, purgeModuleData } from '@tagave/doctor';
import { close, fakeListenbrainz, fakeNavidrome, listen } from '../testkit/playerFakes.js';

vi.mock('../boss.js', () => ({ getBoss: async () => ({ send: async () => 'job' }) }));

const PASSWORD = 'nav-admin-pw';
const PLAYER_TABLES = MODULE_DATA['player']!.tables;

describe.skipIf(!process.env.TEST_DATABASE_URL)('the player plugged in and out', () => {
  let app: FastifyInstance;
  let sql: any;
  const nav = fakeNavidrome(PASSWORD);
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
  const manualListen = randomUUID();
  const t = { one: randomUUID(), two: randomUUID(), three: randomUUID() };
  const f = { one: randomUUID(), two: randomUUID(), three: randomUUID() };
  const as = (user: string, role = 'listener') => ({ 'x-test-user': user, 'x-test-role': role });
  const envKeys = ['TAGAVE_PLAYER_URL', 'TAGAVE_PLAYER_USER', 'TAGAVE_PLAYER_PASSWORD', 'APP_SECRET', 'TAGAVE_LISTENBRAINZ_API_URL'] as const;
  const savedEnv: Record<string, string | undefined> = {};
  let sync: typeof import('../lib/playerSync.js');
  let plays: typeof import('../lib/playerPlays.js');
  let people: typeof import('../lib/playerPeople.js');
  let scrob: typeof import('../lib/scrobbling.js');
  let ratings: typeof import('../lib/playerRatings.js');
  let player: typeof import('../lib/player.js');

  const turnOn = () => {
    process.env['TAGAVE_PLAYER_URL'] = navUrl;
    process.env['TAGAVE_PLAYER_USER'] = 'admin';
    process.env['TAGAVE_PLAYER_PASSWORD'] = PASSWORD;
    player.clearCapabilityCache();
  };
  /** What Turn off does to the app: TAGAVE_PLAYER_URL cleared, the app restarted. */
  const turnOff = () => {
    process.env['TAGAVE_PLAYER_URL'] = '';
    player.clearCapabilityCache();
  };

  beforeAll(async () => {
    for (const k of envKeys) savedEnv[k] = process.env[k];
    process.env['APP_SECRET'] = 'test-app-secret-'.padEnd(48, 'u');
    navUrl = await listen(nav.server);
    process.env['TAGAVE_LISTENBRAINZ_API_URL'] = await listen(lb.server);

    const { initDb } = await import('../db.js');
    sql = (await initDb(process.env.TEST_DATABASE_URL!)).client;
    await sql`insert into users (id, email, display_name, password_hash, role) values
      (${anna}, ${`anna-${anna}@t.com`}, 'Anna Unplug', 'x', 'owner'), (${ben}, ${`ben-${ben}@t.com`}, 'Ben Unplug', 'x', 'listener')`;
    await sql`insert into libraries (id, owner_user_id, name, settings) values (${libraryId}, ${anna}, 'Unplug', ${JSON.stringify({ discogsUser: 'kept' })}::jsonb)`;
    await sql`insert into scan_roots (id, library_id, path, display_name, validation_status) values (${rootId}, ${libraryId}, '/mnt/music', 'Music', 'ok')`;
    await sql`insert into release_groups (id, mbid, title) values (${rgId}, ${randomUUID()}, 'Unplug Album')`;
    await sql`insert into releases (id, release_group_id, mbid, title) values (${releaseId}, ${rgId}, ${releaseMbid}, 'Unplug Album')`;
    await sql`insert into local_albums (id, library_id, cluster_key, title_guess, artist_guess, state, release_id, release_group_id)
              values (${albumId}, ${libraryId}, ${`ck-${albumId}`}, 'Unplug Album', 'The Plugs', 'matched', ${releaseId}, ${rgId})`;
    const file = (id: string, rel: string) => sql`insert into audio_files (id, library_id, scan_root_id, rel_path, container, codec, lossless, duration_ms, status)
      values (${id}, ${libraryId}, ${rootId}, ${rel}, 'flac', 'FLAC', true, 200000, 'present')`;
    await file(f.one, 'The Plugs/Unplug Album/01 In.flac');
    await file(f.two, 'The Plugs/Unplug Album/02 Out.flac');
    await file(f.three, 'The Plugs/Unplug Album/03 Again.flac');
    const track = (id: string, fileId: string, no: number, title: string) => sql`insert into local_tracks (id, local_album_id, audio_file_id, disc_no, track_no, title_guess, artist_guess, duration_ms, origin)
      values (${id}, ${albumId}, ${fileId}, 1, ${no}, ${title}, 'The Plugs', 200000, 'file')`;
    await track(t.one, f.one, 1, 'In');
    await track(t.two, f.two, 2, 'Out');
    await track(t.three, f.three, 3, 'Again');
    // core data a person made without the player: it must come through untouched
    await sql`insert into user_reviews (library_id, user_id, release_group_id, rating, favorite_track_ids) values (${libraryId}, ${anna}, ${rgId}, 4, ${[t.two]})`;
    await sql`insert into listens (id, library_id, user_id, release_group_id, release_id, listened_at, format) values (${manualListen}, ${libraryId}, ${anna}, ${rgId}, ${releaseId}, now() - interval '3 days', 'vinyl')`;
    nav.state.albums.push({
      id: 'al-u', name: 'Unplug Album', artist: 'The Plugs', musicBrainzId: releaseMbid, songs: [
        { id: 'su-1', title: 'In', track: 1, discNumber: 1, path: '/music/The Plugs/Unplug Album/01 In.flac', duration: 200 },
        { id: 'su-2', title: 'Out', track: 2, discNumber: 1, path: '/music/The Plugs/Unplug Album/02 Out.flac', duration: 200 },
        { id: 'su-3', title: 'Again', track: 3, discNumber: 1, path: '/music/The Plugs/Unplug Album/03 Again.flac', duration: 200 },
      ],
    });

    sync = await import('../lib/playerSync.js');
    plays = await import('../lib/playerPlays.js');
    people = await import('../lib/playerPeople.js');
    scrob = await import('../lib/scrobbling.js');
    ratings = await import('../lib/playerRatings.js');
    player = await import('../lib/player.js');

    const { errorHandler } = await import('../middleware/errorHandler.js');
    const { createPlayerRoutes } = await import('./player.js');
    app = Fastify({ logger: false });
    await errorHandler(app);
    app.addHook('preHandler', async (request) => {
      const id = request.headers['x-test-user'];
      request.user = typeof id === 'string' ? ({ id, email: `${id}@t.com`, role: request.headers['x-test-role'] } as any) : undefined;
    });
    await app.register(createPlayerRoutes, { prefix: '/api/v1' });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    for (const s of [nav.server, lb.server]) await close(s);
    if (sql) {
      await sql`delete from libraries where id = ${libraryId}`;
      await sql`delete from releases where id = ${releaseId}`;
      await sql`delete from release_groups where id = ${rgId}`;
      await sql`delete from users where id in (${anna}, ${ben})`;
      await sql`delete from player_retired_accounts where username like 'gone-%'`;
      await sql.end({ timeout: 5 });
    }
    for (const k of envKeys) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  const event = (user: string, kind: string, trackId: string, playedMs: number, queueId = randomUUID()) =>
    app.inject({ method: 'POST', url: '/api/v1/player/events', headers: as(user), payload: { kind, localTrackId: trackId, queueId, playedMs, positionMs: playedMs } });

  /** The player in use, every table of it written through the code that writes it. */
  async function useThePlayer(): Promise<void> {
    turnOn();
    const backend = player.backendFor({})!;
    expect(backend.managed).toBe('bundled');
    await people.syncBundledUsers(sql, backend);
    await scrob.connectAccount(sql, anna, 'listenbrainz', 'anna-lb', 'lb-token-anna');
    await scrob.connectAccount(sql, ben, 'listenbrainz', 'ben-lb', 'lb-token-ben');
    // Anna plays two of the three tracks in tagave: plays, one album listen, scrobbles
    expect((await app.inject({ method: 'GET', url: `/api/v1/player/albums/${albumId}/queue`, headers: as(anna) })).statusCode).toBe(200);
    const q = randomUUID();
    expect((await event(anna, 'completed', t.one, 199_000, q)).statusCode).toBeLessThan(300);
    expect((await event(anna, 'completed', t.two, 190_000, q)).statusCode).toBeLessThan(300);
    await sync.runPlayerFastSync({ sql });
    // Ben plays on his phone: counts, poll state, plays, a listen
    const deps = sync.playsDeps({ sql });
    await plays.pollPerson(deps, backend, ben);
    const [benOnNav] = await sql`select username from player_users where user_id = ${ben}`;
    ['su-1', 'su-2', 'su-3'].forEach((id, i) => nav.phonePlay(benOnNav.username, id, Date.now() - 600_000 + i * 200_000));
    await plays.pollPerson(deps, backend, ben);
    await plays.deriveListens(sql, ben);
    await ratings.syncPersonRatings({ sql }, backend, anna);
    // a scan after a tag write (its status lands in the library's settings), and one still waiting
    await player.requestPlayerScan(sql, null, libraryId, ['The Plugs/Unplug Album']);
    await player.runPlayerScan(sql, libraryId);
    await player.requestPlayerScan(sql, null, libraryId, ['The Plugs']);
    // an account left behind by a person removed with their data (written by the people routes)
    await sql`insert into player_retired_accounts (server_key, username) values ('bundled', ${`gone-${randomUUID().slice(0, 8)}`})`;
  }

  async function counts(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const table of PLAYER_TABLES) out[table] = (await sql.unsafe(`select count(*)::int as n from "${table}"`))[0].n;
    return out;
  }

  async function playerRows(): Promise<Record<string, unknown[]>> {
    const out: Record<string, unknown[]> = {};
    for (const table of PLAYER_TABLES) out[table] = await sql.unsafe(`select * from "${table}" order by 1, 2`);
    return out;
  }

  /** The core rows of this test's people and library; the player's keys in the library's settings left out. */
  async function core() {
    const ids = [anna, ben];
    const [lib] = await sql`select * from libraries where id = ${libraryId}`;
    const { playerLastScan: _scan, ...settings } = lib.settings ?? {};
    return {
      users: await sql`select * from users where id = any(${ids}::uuid[]) order by id`,
      library: { ...lib, settings },
      roots: await sql`select * from scan_roots where library_id = ${libraryId}`,
      releaseGroups: await sql`select * from release_groups where id = ${rgId}`,
      releases: await sql`select * from releases where id = ${releaseId}`,
      albums: await sql`select * from local_albums where id = ${albumId}`,
      tracks: await sql`select * from local_tracks where local_album_id = ${albumId} order by id`,
      files: await sql`select * from audio_files where library_id = ${libraryId} order by id`,
      reviews: await sql`select * from user_reviews where user_id = any(${ids}::uuid[]) order by user_id`,
      listens: await sql`select * from listens where user_id = any(${ids}::uuid[]) order by id`,
    };
  }

  it('is used: every table of the player has rows, and plays became listens', async () => {
    await useThePlayer();
    const n = await counts();
    for (const table of PLAYER_TABLES) expect(n[table], table).toBeGreaterThan(0);
    const listens = await sql`select user_id, source from listens where user_id = any(${[anna, ben]}::uuid[]) order by source, user_id`;
    expect(listens.map((l: any) => l.source).sort()).toEqual(['manual', 'player', 'player']);
    const [lib] = await sql`select settings from libraries where id = ${libraryId}`;
    expect(lib.settings.playerLastScan).toMatchObject({ state: 'requested' });
  });

  it('turned off with its data kept: the background loop does nothing, and every row stays', async () => {
    turnOff();
    // a play reported by a tab still open, after the player went
    expect((await event(anna, 'completed', t.three, 195_000)).statusCode).toBeLessThan(300);
    await sql`update player_scrobbles set status = 'pending', next_attempt_at = now() - interval '1 minute' where service = 'listenbrainz'`;
    await sql`update player_plays set server_report = 'pending' where user_id = ${anna}`;
    const rows = await playerRows();
    const before = await core();
    const sentBefore = lb.state.listens.length;
    const navScrobbles = nav.state.scrobbles.length;
    const fetchImpl = vi.fn(fetch);
    const log = { info: vi.fn(), warn: vi.fn() };
    const clock = { lastMinute: 0, lastNowPlaying: 0 };
    for (let i = 0; i < 3; i++) expect(await sync.playerSyncTick({ sql, fetchImpl, log }, clock)).toBe('idle');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
    expect(lb.state.listens.length).toBe(sentBefore);
    expect(nav.state.scrobbles.length).toBe(navScrobbles);
    expect(await playerRows()).toEqual(rows);
    expect(await core()).toEqual(before);
    // and the loop itself starts, ticks and stops without a word
    const stop = sync.startPlayerPeopleWorker({ sql, fetchImpl, log });
    await new Promise((r) => setTimeout(r, 300));
    stop();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
    expect(await playerRows()).toEqual(rows);
  });

  it('refuses to purge while the player is still on', async () => {
    await expect(purgeModuleData(sql, 'player', { env: { TAGAVE_PLAYER_URL: navUrl } })).rejects.toBeInstanceOf(PurgeRefused);
    await expect(purgeModuleData(sql, 'nothing-here', { env: {} })).rejects.toBeInstanceOf(PurgeRefused);
    for (const table of PLAYER_TABLES) expect((await counts())[table], table).toBeGreaterThan(0);
  });

  it('"Delete its data" deletes exactly the player\'s rows; the core and the listens stay; twice is a no-op', async () => {
    const before = await core();
    const playerListens = before.listens.filter((l: any) => l.source === 'player').length;
    expect(playerListens).toBe(2);
    const first = await purgeModuleData(sql, 'player', { env: {} });
    expect(first.history).toMatchObject({ table: 'listens', action: 'kept' });
    expect(first.history!.count).toBeGreaterThanOrEqual(playerListens);
    expect(first.librariesCleared).toBeGreaterThanOrEqual(1);
    for (const table of PLAYER_TABLES) expect(first.deleted[table], table).toBeGreaterThan(0);
    expect(Object.values(await counts()).every((n) => n === 0)).toBe(true);
    // session keys gone with scrobble_accounts; core identical (the listens included)
    expect(await sql`select 1 from scrobble_accounts`).toHaveLength(0);
    expect(await core()).toEqual(before);
    const [lib] = await sql`select settings from libraries where id = ${libraryId}`;
    expect(lib.settings).toEqual({ discogsUser: 'kept' });

    const again = await purgeModuleData(sql, 'player', { env: {} });
    expect(Object.values(again.deleted).every((n) => n === 0)).toBe(true);
    expect(again.librariesCleared).toBe(0);
    expect(await core()).toEqual(before);
  });

  it('turned on again after the purge, the player starts over and works', async () => {
    await useThePlayer();
    expect((await counts())['player_users']).toBeGreaterThan(0);
    const listens = await sql`select source from listens where user_id = ${anna} and source = 'player'`;
    expect(listens.length).toBeGreaterThanOrEqual(2);
  });

  it('"Delete its data" with play history ticked deletes the player\'s listens too, and only those', async () => {
    turnOff();
    const before = await core();
    expect(before.listens.some((l: any) => l.source === 'player')).toBe(true);
    const r = await purgeModuleData(sql, 'player', { env: {}, deleteHistory: true });
    expect(r.history).toMatchObject({ table: 'listens', action: 'deleted' });
    expect(r.history!.count).toBeGreaterThanOrEqual(before.listens.filter((l: any) => l.source === 'player').length);
    expect(Object.values(await counts()).every((n) => n === 0)).toBe(true);
    expect(await sql`select 1 from listens where source = 'player'`).toHaveLength(0);
    const after = await core();
    // the manual listen stays exactly as it was; everything else in the core too
    expect(after.listens).toEqual(before.listens.filter((l: any) => l.source === 'manual'));
    expect(after.listens.map((l: any) => l.id)).toEqual([manualListen]);
    expect({ ...after, listens: [] }).toEqual({ ...before, listens: [] });
    const again = await purgeModuleData(sql, 'player', { env: {}, deleteHistory: true });
    expect(again.history).toMatchObject({ action: 'deleted', count: 0 });
    expect(await core()).toEqual(after);
  });

  it('removing the bundled player while a server of your own is set up leaves that server, its rows and the scrobble accounts as they were', async () => {
    // the bundled player in use again
    await useThePlayer();
    turnOff();
    // the owner's own server in Settings › Playback (the fake Navidrome under another account: another server_key)
    nav.state.users.set('own-admin', { id: 'nd-own', password: 'own-pw', isAdmin: true, name: 'Own', plays: new Map(), ratings: new Map(), starred: new Set() });
    const ownSettings = { playerUrl: navUrl, playerUser: 'own-admin', playerPassword: sealSecret('own-pw', process.env['APP_SECRET']!), playerPasswordHint: 'w' };
    await sql`update libraries set settings = settings || ${JSON.stringify(ownSettings)}::jsonb where id = ${libraryId}`;
    player.clearCapabilityCache();
    const own = player.backendFor(ownSettings)!;
    expect(own.managed).toBe('external');
    // used through its own code: Anna's login there, a play in tagave, her counts, her ratings
    await people.saveOwnAccount(sql, own, anna, { username: 'own-admin', password: 'own-pw', serverScrobbles: false });
    expect((await app.inject({ method: 'GET', url: `/api/v1/player/albums/${albumId}/queue`, headers: as(anna) })).statusCode).toBe(200);
    const q = randomUUID();
    await event(anna, 'completed', t.one, 199_000, q);
    await event(anna, 'completed', t.three, 199_000, q);
    await sync.runPlayerFastSync({ sql });
    const deps = sync.playsDeps({ sql });
    await plays.pollPerson(deps, own, anna);
    await ratings.syncPersonRatings({ sql }, own, anna);

    const before = await playerRows();
    const bundledRows = (t: string) => (before[t] as any[]).filter((r) => r.server_key === 'bundled').length;
    const ownRows = (t: string) => (before[t] as any[]).filter((r) => r.server_key === own.key).length;
    for (const t of ['player_users', 'player_poll_state', 'player_rating_sync']) {
      expect(bundledRows(t), `${t} bundled`).toBeGreaterThan(0);
      expect(ownRows(t), `${t} own`).toBeGreaterThan(0);
    }
    // one song id per track: the own server's queue took the map over
    expect(ownRows('player_track_map')).toBeGreaterThan(0);
    expect(before['scrobble_accounts']!.length).toBe(2);
    const coreBefore = await core();

    const r = await purgeModuleData(sql, 'player', { env: {} });
    expect(r.keptForLibraries).toBe(1);
    expect(r.deleted['scrobble_accounts']).toBe(0);
    const after = await playerRows();
    const notBundled = (t: string) => (before[t] as any[]).filter((row) => row.server_key !== 'bundled');
    for (const t of ['player_track_map', 'player_song_counts', 'player_poll_state', 'player_rating_sync', 'player_users', 'player_retired_accounts', 'player_events', 'player_plays']) {
      expect(after[t], t).toEqual(notBundled(t));
    }
    const keptPlays = new Set(notBundled('player_plays').map((p: any) => p.id));
    expect(after['player_scrobbles']).toEqual((before['player_scrobbles'] as any[]).filter((s) => keptPlays.has(s.play_id)));
    // keyed by the library (which the own server serves) or by the person: as they were
    for (const t of ['player_listens', 'scrobble_accounts', 'player_scan_requests']) expect(after[t], t).toEqual(before[t]);
    expect(await core()).toEqual(coreBefore);
    const [lib] = await sql`select settings from libraries where id = ${libraryId}`;
    expect(lib.settings).toMatchObject({ ...ownSettings, discogsUser: 'kept' });
    expect(lib.settings.playerLastScan).toBeDefined();
    // the own server still plays: its backend and Anna's login there are intact
    expect((await people.personServer(sql, own, anna))?.kind).toBe('own');
    // again: nothing more goes
    const again = await purgeModuleData(sql, 'player', { env: {} });
    expect(Object.values(again.deleted).every((n) => n === 0)).toBe(true);

    // the own server removed too (Settings › Playback): now nothing of the player is left to keep
    const { playerUrl: _u, playerUser: _n, playerPassword: _p, playerPasswordHint: _h, ...rest } = lib.settings;
    await sql`update libraries set settings = ${JSON.stringify(rest)}::jsonb where id = ${libraryId}`;
    const last = await purgeModuleData(sql, 'player', { env: {} });
    expect(last.keptForLibraries).toBe(0);
    expect(last.deleted['scrobble_accounts']).toBe(2);
    expect(Object.values(await counts()).every((n) => n === 0)).toBe(true);
    expect((await core()).listens).toEqual(coreBefore.listens);
  });
});
