/**
 * Connecting a service queues the person's recent plays that never went to
 * it (the last 14 days, plays that counted, once), and the sender sends a
 * backlog batched: one request per person and service, at most 50 scrobbles
 * per Last.fm call.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { close, fakeLastfm, fakeListenbrainz, listen } from '../testkit/playerFakes.js';

const LASTFM_KEY = 'c'.repeat(32);
const LASTFM_SECRET = 'd'.repeat(32);
const DAY = 24 * 3600_000;

describe.skipIf(!process.env.TEST_DATABASE_URL)('scrobble backfill on connect', () => {
  let sql: any;
  let scrob: typeof import('./scrobbling.js');
  const lfm = fakeLastfm(LASTFM_KEY, LASTFM_SECRET);
  const lb = fakeListenbrainz({ 'lb-token-cara': 'cara-lb' });
  const cara = randomUUID();
  const dan = randomUUID();
  const envKeys = ['APP_SECRET', 'TAGAVE_LASTFM_API_URL', 'TAGAVE_LASTFM_API_KEY', 'TAGAVE_LASTFM_SECRET', 'TAGAVE_LISTENBRAINZ_API_URL'] as const;
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const k of envKeys) savedEnv[k] = process.env[k];
    process.env['APP_SECRET'] = 'test-app-secret-'.padEnd(48, 'b');
    process.env['TAGAVE_LASTFM_API_URL'] = `${await listen(lfm.server)}/2.0/`;
    process.env['TAGAVE_LISTENBRAINZ_API_URL'] = await listen(lb.server);
    process.env['TAGAVE_LASTFM_API_KEY'] = LASTFM_KEY;
    process.env['TAGAVE_LASTFM_SECRET'] = LASTFM_SECRET;
    const { initDb } = await import('../db.js');
    sql = (await initDb(process.env.TEST_DATABASE_URL!)).client;
    scrob = await import('./scrobbling.js');
    await sql`insert into users (id, email, display_name, password_hash, role) values
      (${cara}, ${`cara-${cara}@t.com`}, 'Cara', 'x', 'listener'), (${dan}, ${`dan-${dan}@t.com`}, 'Dan', 'x', 'listener')`;
  });

  afterAll(async () => {
    for (const s of [lfm.server, lb.server]) await close(s);
    if (sql) {
      await sql`delete from users where id in (${cara}, ${dan})`;
      await sql.end({ timeout: 5 });
    }
    for (const k of envKeys) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  beforeEach(async () => {
    await sql`delete from player_plays where user_id in (${cara}, ${dan})`;
    await sql`delete from scrobble_accounts where user_id in (${cara}, ${dan})`;
    await sql`delete from player_users where user_id in (${cara}, ${dan})`;
    lfm.state.scrobbles.length = 0;
    lfm.state.calls.length = 0;
    lb.state.listens.length = 0;
  });

  const play = async (user: string, title: string, agoMs: number, o: { scrobbles?: boolean; artist?: string | null } = {}) => {
    const [r] = await sql`
      insert into player_plays (user_id, dedupe_key, source, title, artist, album, duration_ms, played_ms, started_at, heard, scrobbles)
      values (${user}, ${`test:${randomUUID()}`}, 'web', ${title}, ${o.artist === undefined ? 'The Band' : o.artist}, 'Album', 200000, 200000,
        ${new Date(Date.now() - agoMs).toISOString()}, true, ${o.scrobbles ?? true})
      returning id`;
    return r.id as string;
  };
  const queuedTitles = async (user: string, service: string) =>
    (await sql`select p.title from player_scrobbles s join player_plays p on p.id = s.play_id
      where p.user_id = ${user} and s.service = ${service} and s.status = 'pending' order by p.started_at`).map((r: any) => r.title);

  it('queues only the person\'s own plays that counted, within 14 days, with an artist', async () => {
    await play(cara, 'Yesterday', DAY);
    await play(cara, 'Thirteen days', 13 * DAY);
    await play(cara, 'Fifteen days', 15 * DAY);
    await play(cara, 'Skipped', 2 * DAY, { scrobbles: false });
    await play(cara, 'No artist', 2 * DAY, { artist: null });
    await play(dan, 'Dan\'s play', DAY);
    const n = await scrob.connectAccount(sql, cara, 'lastfm', 'cara-fm', 'sk-cara');
    expect(n).toBe(2);
    expect(await queuedTitles(cara, 'lastfm')).toEqual(['Thirteen days', 'Yesterday']);
    expect(await queuedTitles(cara, 'listenbrainz')).toEqual([]);
    expect(await queuedTitles(dan, 'lastfm')).toEqual([]);
  });

  it('does not queue a play twice: connecting again, or a play already sent or dropped', async () => {
    const sent = await play(cara, 'Already sent', 3 * DAY);
    await sql`insert into player_scrobbles (play_id, service, status) values (${sent}, 'lastfm', 'sent')`;
    await play(cara, 'New one', DAY);
    expect(await scrob.connectAccount(sql, cara, 'lastfm', 'cara-fm', 'sk-cara')).toBe(1);
    expect(await scrob.connectAccount(sql, cara, 'lastfm', 'cara-fm', 'sk-cara')).toBe(0);
    // disconnecting drops what waited; connecting again does not bring it back
    await scrob.disconnectAccount(sql, cara, 'lastfm');
    const [row] = await sql`select s.status, s.last_error from player_scrobbles s join player_plays p on p.id = s.play_id where p.title = 'New one' and p.user_id = ${cara}`;
    expect(row).toMatchObject({ status: 'failed', last_error: 'Disconnected before it was sent' });
    expect(await scrob.connectAccount(sql, cara, 'lastfm', 'cara-fm', 'sk-cara')).toBe(0);
    await scrob.sendDueScrobbles({ sql });
    expect(lfm.state.scrobbles).toHaveLength(0);
  });

  it('queues nothing while the person\'s own server scrobbles for them', async () => {
    await play(cara, 'Yesterday', DAY);
    await sql`insert into player_users (user_id, server_key, username, password_sealed, source, server_scrobbles)
      values (${cara}, 'own:test', ${`cara-${cara}`}, 'enc:v1:x', 'person', true)`;
    expect(await scrob.connectAccount(sql, cara, 'lastfm', 'cara-fm', 'sk-cara')).toBe(0);
  });

  it('ListenBrainz: the same 14 days, sent in one request', async () => {
    for (let i = 0; i < 5; i++) await play(cara, `Track ${i}`, (i + 1) * DAY);
    await play(cara, 'Too old', 20 * DAY);
    expect(await scrob.connectAccount(sql, cara, 'listenbrainz', 'cara-lb', 'lb-token-cara')).toBe(5);
    expect(await scrob.sendDueScrobbles({ sql })).toEqual({ sent: 5, other: 0 });
    expect(lb.state.listens).toHaveLength(1);
    expect(lb.state.listens[0]!.body.listen_type).toBe('import');
    expect(lb.state.listens[0]!.body.payload).toHaveLength(5);
  });

  it('sends a Last.fm backlog in calls of at most 50, oldest first, each once', async () => {
    for (let i = 0; i < 60; i++) await play(cara, `Track ${i}`, DAY + i * 60_000);
    expect(await scrob.connectAccount(sql, cara, 'lastfm', 'cara-fm', 'sk-cara')).toBe(60);
    // one tick claims 50: one call
    expect(await scrob.sendDueScrobbles({ sql })).toEqual({ sent: 50, other: 0 });
    expect(lfm.state.calls).toHaveLength(1);
    const stamps = lfm.state.scrobbles.map((s) => Number(s['timestamp']));
    expect(stamps).toEqual([...stamps].sort((x, y) => x - y));
    // a larger claim still splits into calls of 50
    expect(await scrob.sendDueScrobbles({ sql }, 200)).toEqual({ sent: 10, other: 0 });
    expect(lfm.state.calls).toHaveLength(2);
    expect(new Set(lfm.state.scrobbles.map((s) => s['track'])).size).toBe(60);
    expect(await scrob.sendDueScrobbles({ sql }, 200)).toEqual({ sent: 0, other: 0 });
  });

  it('stops sending a person\'s backlog for the tick when Last.fm is offline', async () => {
    for (let i = 0; i < 70; i++) await play(cara, `Track ${i}`, DAY + i * 60_000);
    await scrob.connectAccount(sql, cara, 'lastfm', 'cara-fm', 'sk-cara');
    lfm.state.failNext = 1;
    expect(await scrob.sendDueScrobbles({ sql }, 100)).toEqual({ sent: 0, other: 70 });
    expect(lfm.state.calls).toHaveLength(1);
    const [st] = await sql`select count(*)::int as n from player_scrobbles s join player_plays p on p.id = s.play_id
      where p.user_id = ${cara} and s.status = 'pending' and s.last_error = 'Service Offline'`;
    expect(st.n).toBe(70);
  });
});
