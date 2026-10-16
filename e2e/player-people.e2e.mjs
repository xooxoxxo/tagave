#!/usr/bin/env node
/**
 * The player per person, end to end, with a real Navidrome and real Chrome:
 *
 *   1. two people (an owner and a listener) sign in; a generated library
 *      is scanned by tagave's worker (identification is stubbed: the
 *      release rows are written straight into the database);
 *   2. the owner saves a Last.fm API key (Settings › Playback ›
 *      Scrobbling); each person connects their own Last.fm (web sign-in
 *      through the fake) and ListenBrainz (a token) in Settings › Listening;
 *   3. each person plays a whole album in tagave's web player, at the same
 *      time, in their own browser: tagave makes one Navidrome user each and
 *      streams as them;
 *   4. the listener plays an album through Navidrome's Subsonic API as a
 *      phone app would (their own phone-app password);
 *   5. the owner rates an album in tagave;
 *   then checks: separate play counts per Navidrome user, plays and album
 *   listens per person, each play scrobbled exactly once per service at the
 *   fakes, now playing sent, the rating on the owner's Navidrome user only,
 *   and that seeing everything again (events re-processed, a full re-poll)
 *   sends nothing twice.
 *
 * Needs a running tagave API + file worker (this branch's build) with the
 * bundled-player settings pointing at the Navidrome, PUBLIC_URL = BASE_URL,
 * and the Last.fm / ListenBrainz URLs pointing at e2e/fake-scrobblers.mjs:
 *
 *   BASE_URL=http://localhost:3394 DATABASE_URL=postgres://…/tagave_e2e \
 *   ND_URL=http://127.0.0.1:4533 FAKES_URL=http://127.0.0.1:3398 MUSIC_DIR=/path/to/music \
 *   LASTFM_KEY=… LASTFM_SECRET=… PLAYWRIGHT_CORE=/path/to/playwright-core/index.mjs \
 *   node e2e/player-people.e2e.mjs
 *
 * MUSIC_DIR holds the albums Navidrome also has (same relative paths):
 * "Artist 1/Album 1/0N Song 1-N.flac" and "Artist 2/Album 2/…", four
 * 35-second tracks each, with MUSICBRAINZ_ALBUMID tags. Never point it at
 * production: it writes to the database.
 */
import { createRequire } from 'node:module';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const requireFromAuth = createRequire(path.join(here, '../packages/auth/package.json'));
const postgres = (await import(pathToFileURL(requireFromAuth.resolve('postgres')).href)).default;
const argon2 = (await import(pathToFileURL(requireFromAuth.resolve('argon2')).href)).default;
const { chromium } = await import(process.env.PLAYWRIGHT_CORE ? pathToFileURL(process.env.PLAYWRIGHT_CORE).href : 'playwright-core');

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3394';
const ND_URL = process.env.ND_URL ?? 'http://127.0.0.1:4533';
const FAKES_URL = process.env.FAKES_URL ?? 'http://127.0.0.1:3398';
const MUSIC_DIR = process.env.MUSIC_DIR;
const LASTFM_KEY = process.env.LASTFM_KEY ?? 'a'.repeat(32);
const LASTFM_SECRET = process.env.LASTFM_SECRET ?? 'b'.repeat(32);
const OUT = process.env.OUT_DIR ?? path.join(here, '../.e2e-out');
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!process.env.DATABASE_URL || !MUSIC_DIR) throw new Error('DATABASE_URL and MUSIC_DIR are required');
if (/prod|\.ts\.net|tagave\.(app|io)/i.test(process.env.DATABASE_URL + BASE_URL)) throw new Error('refusing to run against what looks like production');
mkdirSync(OUT, { recursive: true });

const sql = postgres(process.env.DATABASE_URL, { max: 2, onnotice: () => undefined });
const crypto = globalThis.crypto;
const results = [];
function step(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
  if (!ok) throw new Error(`step failed: ${name} ${detail}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, { timeoutMs = 120_000, everyMs = 1000 } = {}) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await sleep(everyMs);
  }
  throw new Error(`timed out waiting for ${what} (last: ${JSON.stringify(last)})`);
}
const fakes = async () => (await fetch(`${FAKES_URL}/_log`)).json();

/** Subsonic as a phone app would call it (token auth). */
async function subsonic(user, password, method, params = {}, client = 'Symfonium') {
  const s = randomBytes(6).toString('hex');
  const q = new URLSearchParams({ u: user, t: createHash('md5').update(password + s).digest('hex'), s, v: '1.16.1', c: client, f: 'json' });
  for (const [k, v] of Object.entries(params)) q.set(k, String(v));
  const r = (await (await fetch(`${ND_URL}/rest/${method}?${q}`)).json())['subsonic-response'];
  if (r.status !== 'ok') throw new Error(`${method}: ${JSON.stringify(r.error)}`);
  return r;
}

const run = randomBytes(3).toString('hex');
const people = {
  anna: { email: `anna-${run}@example.test`, name: 'Anna', password: 'anna e2e password!', role: 'owner', phone: 'anna phone password 1', lb: `lb-anna-${run}token` },
  ben: { email: `ben-${run}@example.test`, name: 'Ben', password: 'ben e2e password!!', role: 'viewer', phone: 'ben phone password 12', lb: `lb-ben-${run}token` },
};

async function createPeople() {
  for (const p of Object.values(people)) {
    const hash = await argon2.hash(p.password, { type: argon2.argon2id });
    const [u] = await sql`insert into users (email, display_name, password_hash, role) values (${p.email}, ${p.name}, ${hash}, ${p.role}) returning id`;
    await sql`insert into auth_accounts (user_id, account_id, provider_id, password) values (${u.id}, ${u.id}::text, 'credential', ${hash})`;
    p.id = u.id;
  }
  const [lib] = await sql`insert into libraries (owner_user_id, name, settings)
    values (${people.anna.id}, 'E2E player library', ${sql.json({ contactString: people.anna.email, onboardingCompletedAt: new Date().toISOString() })}) returning id`;
  return lib.id;
}

async function signIn(context, p) {
  const page = await context.newPage();
  await page.goto('/login');
  await page.getByLabel('Email').fill(p.email);
  await page.locator('input#password').fill(p.password);
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 15000 });
  return page;
}

const api = (page) => ({
  get: async (p) => (await page.request.get(`${BASE_URL}/api/v1${p}`)).json(),
  send: async (method, p, data) => {
    const r = await page.request.fetch(`${BASE_URL}/api/v1${p}`, { method, headers: { 'content-type': 'application/json', origin: BASE_URL }, ...(data === undefined ? {} : { data }) });
    return { status: r.status(), body: await r.json().catch(() => null) };
  },
});

let browser;
const summary = { run };
try {
  const libraryId = await createPeople();
  step('two people: an owner and a listener', true, `${people.anna.email}, ${people.ben.email}`);

  browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
  const ctxA = await browser.newContext({ baseURL: BASE_URL, viewport: { width: 1440, height: 900 } });
  const ctxB = await browser.newContext({ baseURL: BASE_URL, viewport: { width: 1440, height: 900 } });
  const anna = await signIn(ctxA, people.anna);
  const ben = await signIn(ctxB, people.ben);
  step('both signed in', true);

  // ---- the library: scanned by the worker, identification stubbed ----
  const root = await api(anna).send('POST', `/libraries/${libraryId}/scan-roots`, { path: MUSIC_DIR, displayName: 'E2E music', writable: false });
  step('scan root added', root.status === 201, JSON.stringify(root.body).slice(0, 120));
  await until('the folder to be checked', async () => (await sql`select validation_status from scan_roots where id = ${root.body.id}`)[0]?.validation_status !== 'pending');
  const scan = await api(anna).send('POST', `/libraries/${libraryId}/scan-roots/${root.body.id}/scan`, {});
  step('scan started', scan.status < 300, String(scan.status));
  const albums = await until('both albums with four tracks', async () => {
    const rows = await sql`select la.id, la.title_guess, la.embedded_mbid, count(lt.id)::int as tracks from local_albums la
      join local_tracks lt on lt.local_album_id = la.id where la.library_id = ${libraryId} group by la.id order by la.title_guess`;
    return rows.length === 2 && rows.every((r) => r.tracks === 4) ? rows : null;
  }, { timeoutMs: 180_000 });
  for (const a of albums) {
    const mbid = a.embedded_mbid ?? randomBytes(16).toString('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
    const [rg] = await sql`insert into release_groups (mbid, title) values (${randomBytes(16).toString('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5')}, ${a.title_guess}) returning id`;
    const [rel] = await sql`insert into releases (release_group_id, mbid, title) values (${rg.id}, ${mbid}, ${a.title_guess}) returning id`;
    await sql`update local_albums set release_id = ${rel.id}, release_group_id = ${rg.id}, state = 'matched' where id = ${a.id}`;
    a.releaseId = rel.id;
    a.rgId = rg.id;
  }
  const [album1, album2] = albums;
  step('library scanned: 2 albums x 4 tracks (releases stubbed)', true, albums.map((a) => `${a.title_guess} ${a.embedded_mbid}`).join(', '));

  // ---- scrobbling set up from the UI ----
  await anna.goto('/settings/playback');
  await anna.getByLabel('API key').fill(LASTFM_KEY);
  await anna.getByLabel('Shared secret').fill(LASTFM_SECRET);
  await anna.getByRole('button', { name: 'Save', exact: true }).click();
  await anna.getByText('Saved. Last.fm accepted the key.').waitFor({ timeout: 15000 });
  step('owner saved the Last.fm API key in Settings › Playback › Scrobbling', true);

  for (const [who, page] of [['anna', anna], ['ben', ben]]) {
    await page.goto('/settings/listening');
    await page.getByRole('button', { name: 'Connect Last.fm' }).click();
    await page.waitForURL((u) => u.pathname === '/settings/listening' && u.search === '', { timeout: 20000 }).catch(() => undefined);
    await page.getByText('Last.fm is connected.').waitFor({ timeout: 15000 });
    await page.getByLabel('Your ListenBrainz user token').fill(people[who].lb);
    await page.getByRole('button', { name: 'Connect ListenBrainz' }).click();
    await page.getByText(/Connected as /).nth(1).waitFor({ timeout: 15000 });
    await page.getByLabel(/Password for apps/).fill(people[who].phone);
    await page.getByRole('button', { name: 'Set password' }).click();
    await page.getByText('A password for apps is set.').waitFor({ timeout: 30000 });
  }
  const accounts = await sql`select u.email, s.service, s.account_name from scrobble_accounts s join users u on u.id = s.user_id where u.id in (${people.anna.id}, ${people.ben.id}) order by u.email, s.service`;
  step('each person connected Last.fm and ListenBrainz from Settings › Listening', accounts.length === 4, accounts.map((a) => `${a.email.split('-')[0]}:${a.service}=${a.account_name}`).join(' '));
  const nd = await sql`select u.email, pu.username, pu.phone_password from player_users pu join users u on u.id = pu.user_id where u.id in (${people.anna.id}, ${people.ben.id}) order by u.email`;
  for (const r of nd) (r.email.startsWith('anna') ? people.anna : people.ben).nd = r.username;
  step('one Navidrome user per person, phone passwords set', nd.length === 2 && nd.every((r) => r.phone_password), nd.map((r) => r.username).join(', '));
  await subsonic(people.ben.nd, people.ben.phone, 'ping');
  step('the listener signs in to Navidrome with their phone password', true);

  // the first look at each person's counts on the server, before anything is played
  await until('the baseline poll of both people', async () => {
    const n = (await sql`select count(*)::int as n from player_poll_state where user_id in (${people.anna.id}, ${people.ben.id}) and baseline_at is not null`)[0].n;
    return n === 2;
  }, { timeoutMs: 90_000 });

  // ---- both play an album in tagave, at the same time ----
  const playThrough = async (page, album) => {
    await page.goto(`/albums/${album.id}`);
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await page.getByRole('region', { name: 'Player' }).waitFor({ timeout: 20000 });
  };
  // The listener plays through the same calls the web player makes (queue,
  // the stream of each track, now playing, completed), from their own signed-in
  // browser context: on this branch alone the album page is still the
  // library owner's (the household change that lets every person open every
  // album lands with the users-and-roles work).
  const playAsWebPlayer = async (page, album) => {
    const queueId = crypto.randomUUID();
    const queue = await api(page).get(`/player/albums/${album.id}/queue`);
    for (const t of queue.tracks) {
      const audio = await page.request.get(`${BASE_URL}/api/v1/player/stream/${t.localTrackId}?format=original`);
      if (audio.status() !== 200 || (await audio.body()).length < 1000) throw new Error(`stream ${t.title}: ${audio.status()}`);
      await api(page).send('POST', '/player/events', { kind: 'now_playing', localTrackId: t.localTrackId, queueId, playedMs: 0, positionMs: 0 });
      await sleep(3000);
      await api(page).send('POST', '/player/events', { kind: 'completed', localTrackId: t.localTrackId, queueId, playedMs: t.durationMs - 300, positionMs: t.durationMs });
    }
  };
  const startedAt = Date.now();
  await Promise.all([playThrough(anna, album1), playAsWebPlayer(ben, album2)]);
  step('the owner pressed Play in Chrome; the listener played Album 2 through the web player’s calls', true);
  await sleep(4000);
  await anna.getByRole('button', { name: 'Queue' }).click();
  await anna.getByRole('heading', { name: 'Queue' }).waitFor();
  await anna.screenshot({ path: path.join(OUT, 'e2e-queue-while-playing.png') });
  await anna.keyboard.press('Escape');
  await until('all eight tracks to finish', async () => {
    const n = (await sql`select count(*)::int as n from player_events where kind = 'completed' and user_id in (${people.anna.id}, ${people.ben.id})`)[0].n;
    return n >= 8 ? n : null;
  }, { timeoutMs: 300_000, everyMs: 3000 });
  summary.playSeconds = Math.round((Date.now() - startedAt) / 1000);
  const streams = await sql`select u.email, count(*)::int as n from player_events e join users u on u.id = e.user_id where e.kind = 'completed' and u.id in (${people.anna.id}, ${people.ben.id}) group by u.email`;
  step('the web player played both albums through, four tracks each', streams.every((s) => s.n === 4), `${summary.playSeconds}s, ${streams.map((s) => `${s.email.split('-')[0]}=${s.n}`).join(' ')}`);

  // ---- a phone app plays album 1 as the listener ----
  const nd1 = (await subsonic(people.ben.nd, people.ben.phone, 'getAlbumList2', { type: 'alphabeticalByName', size: 10 })).albumList2.album.find((a) => a.name === 'Album 1');
  const songs1 = (await subsonic(people.ben.nd, people.ben.phone, 'getAlbum', { id: nd1.id })).album.song;
  await subsonic(people.ben.nd, people.ben.phone, 'scrobble', { id: songs1[0].id, submission: 'false' });
  const t0 = Date.now() - 4 * 36_000;
  for (const [i, s] of songs1.entries()) await subsonic(people.ben.nd, people.ben.phone, 'scrobble', { id: s.id, submission: 'true', time: t0 + i * 36_000 });
  step('a phone app (Subsonic, as the listener) played Album 1', true, songs1.map((s) => s.title).join(', '));

  // ---- the owner rates album 1 ----
  const rated = await api(anna).send('PUT', `/libraries/${libraryId}/release-groups/${album1.rgId}/review`, { rating: 4.5 });
  step('the owner rated Album 1 4.5 stars in tagave', rated.status < 300, String(rated.status));

  // ---- what came back ----
  await until('the phone plays to come back to tagave', async () => {
    const n = (await sql`select count(*)::int as n from player_plays where user_id = ${people.ben.id} and source = 'server'`)[0].n;
    return n === 4 ? n : null;
  }, { timeoutMs: 100_000, everyMs: 2000 });
  await until('the rating to reach Navidrome', async () => {
    const a = (await subsonic(people.anna.nd, people.anna.phone, 'getAlbum', { id: nd1.id })).album;
    return a.userRating === 5 ? a : null;
  }, { timeoutMs: 100_000, everyMs: 2000 });
  await until('every scrobble to be sent', async () => {
    const n = (await sql`select count(*)::int as n from player_scrobbles s join player_plays p on p.id = s.play_id where p.user_id in (${people.anna.id}, ${people.ben.id}) and s.status in ('pending','sending')`)[0].n;
    return n === 0;
  }, { timeoutMs: 60_000, everyMs: 2000 });

  const counts = {};
  for (const who of ['anna', 'ben']) {
    const p = people[who];
    const list = (await subsonic(p.nd, p.phone, 'getAlbumList2', { type: 'alphabeticalByName', size: 10 })).albumList2.album;
    counts[who] = {};
    for (const a of list) counts[who][a.name] = (await subsonic(p.nd, p.phone, 'getAlbum', { id: a.id })).album.song.map((s) => s.playCount ?? 0);
  }
  summary.navidromePlayCounts = counts;
  step('separate play counts per Navidrome user', JSON.stringify(counts) === JSON.stringify({ anna: { 'Album 1': [1, 1, 1, 1], 'Album 2': [0, 0, 0, 0] }, ben: { 'Album 1': [1, 1, 1, 1], 'Album 2': [1, 1, 1, 1] } }), JSON.stringify(counts));
  const annaRating = (await subsonic(people.anna.nd, people.anna.phone, 'getAlbum', { id: nd1.id })).album.userRating;
  const benRating = (await subsonic(people.ben.nd, people.ben.phone, 'getAlbum', { id: nd1.id })).album.userRating ?? 0;
  step('the rating is on the owner’s Navidrome user only (4.5 → 5)', annaRating === 5 && benRating === 0, `anna=${annaRating} ben=${benRating}`);

  const plays = await sql`select u.display_name as who, p.source, p.album, count(*)::int as n from player_plays p join users u on u.id = p.user_id
    where u.id in (${people.anna.id}, ${people.ben.id}) group by 1, 2, 3 order by 1, 2, 3`;
  summary.plays = plays;
  step('plays per person', JSON.stringify(plays.map((r) => [r.who, r.source, r.album, r.n])) === JSON.stringify([['Anna', 'web', 'Album 1', 4], ['Ben', 'server', 'Album 1', 4], ['Ben', 'web', 'Album 2', 4]]), plays.map((r) => `${r.who}/${r.source}/${r.album}=${r.n}`).join(' '));
  const listens = await sql`select u.display_name as who, la.title_guess as album, l.source, l.format, pl.tracks_heard from player_listens pl
    join users u on u.id = pl.user_id join local_albums la on la.id = pl.local_album_id left join listens l on l.id = pl.listen_id
    where u.id in (${people.anna.id}, ${people.ben.id}) order by 1, 2`;
  summary.listens = listens;
  step('one album listen per person and album, on the release (listens.source = player)', listens.length === 3 && listens.every((l) => l.source === 'player' && l.format === 'digital' && l.tracks_heard === 4), listens.map((l) => `${l.who}:${l.album}`).join(' '));
  const albumPage = await api(anna).get(`/libraries/${libraryId}/release-groups/${album1.rgId}/reviews`).catch(() => null);
  summary.albumListensForOwner = albumPage?.listens?.length ?? null;

  let log = await fakes();
  const fm = log.lastfm.scrobbles.map((s) => `${s.user}:${s.track}`);
  const lb = log.listenbrainz.listens.filter((l) => l.type === 'single').map((l) => `${l.user}:${l.payload[0].track_metadata.track_name}`);
  summary.lastfmScrobbles = fm;
  summary.listenbrainzListens = lb;
  summary.lastfmNowPlaying = log.lastfm.nowPlaying.map((n) => `${n.user}:${n.track}`);
  summary.listenbrainzPlayingNow = log.listenbrainz.listens.filter((l) => l.type === 'playing_now').map((l) => `${l.user}:${l.payload[0].track_metadata.track_name}`);
  const dup = (xs) => xs.length !== new Set(xs.map((x, i) => `${x}#${log.lastfm.scrobbles[i]?.timestamp ?? ''}`)).size;
  step('Last.fm got 12 scrobbles: 4 for the owner, 8 for the listener (4 web + 4 phone)', fm.length === 12 && fm.filter((x) => x.startsWith('fm-listener-1')).length + fm.filter((x) => x.startsWith('fm-listener-2')).length === 12 && !dup(fm), fm.join(', '));
  step('ListenBrainz got the same 12, per person', lb.filter((x) => x.startsWith('anna')).length === 4 && lb.filter((x) => x.startsWith('ben')).length === 8, lb.join(', '));
  step('now playing went out for the web player and the phone app', summary.lastfmNowPlaying.length >= 3 && summary.listenbrainzPlayingNow.some((x) => x.startsWith('ben')), `${summary.lastfmNowPlaying.length} Last.fm, ${summary.listenbrainzPlayingNow.length} ListenBrainz`);
  const fmTimestamps = log.lastfm.scrobbles.map((s) => `${s.user}|${s.track}|${s.album}|${s.timestamp}`);
  step('no scrobble twice (same person, track, start)', new Set(fmTimestamps).size === fmTimestamps.length);

  // ---- see everything again: nothing new may go out ----
  await sql`update player_events set processed_at = null where user_id in (${people.anna.id}, ${people.ben.id})`;
  await sql`update player_poll_state set cursor_at = cursor_at - interval '2 hours' where user_id in (${people.anna.id}, ${people.ben.id})`;
  await sleep(75_000);
  log = await fakes();
  const again = await sql`select count(*)::int as n from player_plays where user_id in (${people.anna.id}, ${people.ben.id})`;
  const listensAgain = await sql`select count(*)::int as n from player_listens where user_id in (${people.anna.id}, ${people.ben.id})`;
  step('re-processing every event and re-polling every count sends nothing twice', log.lastfm.scrobbles.length === 12 && log.listenbrainz.listens.filter((l) => l.type === 'single').length === 12 && again[0].n === 12 && listensAgain[0].n === 3,
    `plays ${again[0].n}, listens ${listensAgain[0].n}, Last.fm ${log.lastfm.scrobbles.length}, ListenBrainz ${log.listenbrainz.listens.filter((l) => l.type === 'single').length}`);
  writeFileSync(path.join(OUT, 'fake-scrobblers-log.json'), JSON.stringify(log, null, 2));
  summary.people = { anna: { email: people.anna.email, navidrome: people.anna.nd }, ben: { email: people.ben.email, navidrome: people.ben.nd } };
} finally {
  writeFileSync(path.join(OUT, 'player-people-e2e.json'), JSON.stringify({ results, summary }, null, 2));
  await browser?.close();
  await sql.end({ timeout: 5 });
}
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} steps passed`);
