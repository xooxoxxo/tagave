/**
 * Spot checks per band against the real server on a scratch database (the
 * module switch is install-wide, so it is never flipped on the shared test
 * database): checks are drawn at random from all of a band's picks in a
 * run, in an order fixed by the run's seed, never the same pick twice; the
 * owner's verdicts feed the band table's Clopper-Pearson gate, where
 * unsure never counts; a check shows the owner's album beside the chosen
 * edition. Nothing is sent anywhere: pg-boss is a stand-in.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import postgres from 'postgres';
import { setAutotaggerEnabled, syncInstalledModules } from '@tagave/db';
import { ledgerEntries } from '@tagave/core/facets';
import { JEV_SPEC } from '@tagave/core';
import { BAND_IDS } from '@tagave/shared';
import type { AuthHandle } from '@tagave/auth';

vi.mock('../boss.js', () => ({ getBoss: async () => ({ send: vi.fn(async () => 'job'), cancel: vi.fn(async () => undefined) }) }));

const { registerApiRoutes } = await import('../app.js');
const { initAuth } = await import('../middleware/auth.js');
const { TEST_PUBLIC_URL, createScratchDb, migrateAll, testAuth } = await import('../testkit/authApp.js');
const { createTestUser } = await import('../testkit/users.js');
const { initDb } = await import('../db.js');
type TestUser = Awaited<ReturnType<typeof createTestUser>>;

const adminUrl = process.env.TEST_DATABASE_URL;

const PICKS_P99 = 400;
const PICKS_P97 = 20;
const SEED = 424242;

describe.skipIf(!adminUrl)('autotagger spot checks (integration, scratch db)', () => {
  let db: { url: string; name: string };
  let sql: postgres.Sql;
  let handle: AuthHandle;
  let app: FastifyInstance;
  let owner: TestUser;
  let editor: TestUser;
  let listener: TestUser;
  let lib = '';
  let otherLib = '';
  let run = '';
  let runningRun = '';
  let otherRun = '';
  let release = '';
  let scannedAlbum = '';

  const call = async (u: TestUser, method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) =>
    app.inject({ method, url, headers: { cookie: u.cookie, origin: TEST_PUBLIC_URL }, ...(payload ? { payload } : {}) });
  const get = async (url: string) => (await call(owner, 'GET', url)).json();
  const post = (url: string, body: object, u: TestUser = owner) => call(u, 'POST', url, body);
  const put = (url: string, body: object, u: TestUser = owner) => call(u, 'PUT', url, body);

  const runUrl = (r = run, l = lib) => `/api/v1/libraries/${l}/autotagger/runs/${r}`;
  const checkUrl = (id: string, l = lib) => `/api/v1/libraries/${l}/autotagger/spot-checks/${id}`;
  const bands = async (r = run) => get(`${runUrl(r)}/bands`);
  const draw = (band: string, count?: number, r = run) => post(`${runUrl(r)}/spot-checks/draw`, count === undefined ? { band } : { band, count });

  /** Give `n` more checks of the band this verdict, drawing more when none are pending, all through the routes. */
  async function markAll(r: string, band: string, n: number, verdict: string, u: TestUser = owner): Promise<void> {
    let left = n;
    while (left > 0) {
      const pending = await get(`${runUrl(r)}/spot-checks?band=${band}&verdict=pending&limit=${Math.min(100, left)}`);
      if (pending.length === 0) {
        const d = await draw(band, Math.min(100, left), r);
        expect(d.statusCode).toBe(200);
        if (d.json().drawn === 0) throw new Error(`no ${band} picks left to draw`);
        continue;
      }
      for (const item of pending) expect((await put(checkUrl(item.id), { verdict }, u)).statusCode).toBe(204);
      left -= pending.length;
    }
  }

  /** The run's picks of the band in the run's shuffled order (what the draws must follow). */
  const shuffled = async (band: string, r = run) => (await sql<Array<{ id: string }>>`
    select d.id::text as id from decider_decisions d join decider_runs x on x.id = d.run_id
     where d.run_id = ${r} and d.band = ${band} and d.outcome = 'pick'
     order by md5(d.id::text || x.seed::text), d.id`).map((x) => x.id);
  const drawnIds = async (band: string, r = run) => (await sql<Array<{ id: string }>>`
    select decision_id::text as id from decider_spot_checks where run_id = ${r} and band = ${band}`).map((x) => x.id);

  async function makeRun(libraryId: string, state: string, seed: number): Promise<string> {
    const [r] = await sql<Array<{ id: string }>>`
      insert into decider_runs (library_id, decider_id, spec_hash, model_requested, decider_version, population, state, seed, started_by_user_id, finished_at)
      values (${libraryId}, 'jev', 'tagave-tracklist-v1@000000000000', 'jev-latest', 'jev-2026-09-15', 'needs_review', ${state}, ${seed}, ${owner.userId}, now())
      returning id::text as id`;
    return r!.id;
  }

  /** `n` albums in review with stored evidence (a track titled from a file name among them), each picked in `band`. */
  async function makePicks(libraryId: string, runId: string, band: string, n: number, probability: number): Promise<string[]> {
    const albums = await sql<Array<{ id: string }>>`
      insert into local_albums (library_id, cluster_key, title_guess, artist_guess, year_guess, state, identify_reason, track_count, last_identify_at)
      select ${libraryId}, 'k-' || gen_random_uuid(), 'Albumi ' || g, 'Kuunvalo', 2001, 'needs_review', 'close call', 3, now()
        from generate_series(1, ${n}) g
      returning id::text as id`;
    const ids = albums.map((a) => a.id);
    await sql`
      insert into album_evidence (local_album_id, v, evidence)
      select id, 1, jsonb_build_object('v', 1, 'artist', 'Kuunvalo', 'title', 'Albumi', 'titleSource', 'tag', 'year', 2001, 'yearSource', 'tag',
                                       'discsKnown', false, 'discCount', null, 'tracks', jsonb_build_array(
        jsonb_build_object('i', 0, 'disc', null, 'title', 'Ilta', 'titleSource', 'tag', 'durS', 200),
        jsonb_build_object('i', 1, 'disc', null, 'title', '02 oma tiedosto', 'titleSource', 'filename', 'durS', 210),
        jsonb_build_object('i', 2, 'disc', null, 'title', 'Yö', 'titleSource', 'tag', 'durS', null)))
        from unnest(${ids}::uuid[]) as id`;
    await sql`
      insert into decider_decisions (run_id, local_album_id, outcome, group_label, group_release_ids, release_id, distance, source, probability, margin, band, evidence_hash, last_identify_at)
      select ${runId}, id, 'pick', 'A', array[${release}::uuid, gen_random_uuid()], ${release}, 0.05, 'mb_search', ${probability}, 0.6, ${band}, repeat('a', 64), now()
        from unnest(${ids}::uuid[]) as id`;
    return ids;
  }

  beforeAll(async () => {
    const admin = postgres(adminUrl!, { max: 1, onnotice: () => undefined });
    db = await createScratchDb(adminUrl!, admin);
    await admin.end({ timeout: 2 });
    await migrateAll(db.url);
    await initDb(db.url);
    handle = testAuth(db.url);
    initAuth(handle);
    sql = postgres(db.url, { max: 4, onnotice: () => undefined });
    await syncInstalledModules(sql, ledgerEntries());
    await setAutotaggerEnabled(sql, true);
    owner = await createTestUser(handle, { role: 'owner', name: 'Ada' });
    editor = await createTestUser(handle, { role: 'editor' });
    listener = await createTestUser(handle, { role: 'listener' });
    const [l] = await sql<Array<{ id: string }>>`insert into libraries (owner_user_id, name, settings) values (${owner.userId}, 'Music', '{}'::jsonb) returning id::text as id`;
    lib = l!.id;
    const [o] = await sql<Array<{ id: string }>>`insert into libraries (owner_user_id, name, settings) values (${owner.userId}, 'Other', '{}'::jsonb) returning id::text as id`;
    otherLib = o!.id;
    const rg = randomUUID();
    await sql`insert into release_groups (id, mbid, title, artist_credit) values (${rg}, ${randomUUID()}, 'Albumi', ${JSON.stringify(['Kuunvalo'])}::text::jsonb)`;
    release = randomUUID();
    await sql`insert into releases (id, release_group_id, mbid, title, status, date, country, labels, media, track_count, source_of_truth)
              values (${release}, ${rg}, ${randomUUID()}, 'Albumi (remaster)', 'Official', '2001-05-04', 'FI',
                      ${JSON.stringify([{ name: 'Levy-yhtiö', catalogNumber: 'LY-001' }])}::text::jsonb,
                      ${JSON.stringify([{ position: 1, format: 'CD', trackCount: 3 }])}::text::jsonb, 3, 'musicbrainz')`;
    for (const [i, t] of ['Ilta', 'Toinen', 'Yö'].entries()) {
      await sql`insert into canonical_tracks (release_id, medium_no, position, number, title, length_ms) values (${release}, 1, ${i + 1}, ${String(i + 1)}, ${t}, ${200_000 + i * 10_000})`;
    }
    run = await makeRun(lib, 'done', SEED);
    await makePicks(lib, run, 'p99', PICKS_P99, 0.995);
    await makePicks(lib, run, 'p97', PICKS_P97, 0.975);
    // a none is never drawn
    const [none] = await sql<Array<{ id: string }>>`insert into local_albums (library_id, cluster_key, state) values (${lib}, ${'k-' + randomUUID()}, 'needs_review') returning id::text as id`;
    await sql`insert into decider_decisions (run_id, local_album_id, outcome, reason) values (${run}, ${none!.id}, 'none', 'margin')`;
    // one p95 pick whose album has no stored evidence: its tracks as scanned
    const [scanned] = await sql<Array<{ id: string }>>`
      insert into local_albums (library_id, cluster_key, title_guess, artist_guess, state, track_count) values (${lib}, ${'k-' + randomUUID()}, 'Skannattu', 'Kuunvalo', 'needs_review', 2)
      returning id::text as id`;
    scannedAlbum = scanned!.id;
    const root = randomUUID();
    await sql`insert into scan_roots (id, library_id, path, display_name, validation_status) values (${root}, ${lib}, '/nowhere', 'test', 'ok')`;
    for (const [i, t] of ['Kaksi', 'Yksi'].entries()) {
      const [f] = await sql<Array<{ id: string }>>`
        insert into files (library_id, scan_root_id, rel_path, handler) values (${lib}, ${root}, ${`S/${i}.flac`}, 'audio') returning id::text as id`;
      // stored out of order: the view orders by disc and track
      await sql`insert into local_tracks (local_album_id, audio_file_id, disc_no, track_no, title_guess, duration_ms) values (${scannedAlbum}, ${f!.id}, 1, ${2 - i}, ${t}, ${(i + 1) * 61_000})`;
    }
    await sql`insert into decider_decisions (run_id, local_album_id, outcome, group_release_ids, release_id, distance, source, probability, band)
              values (${run}, ${scannedAlbum}, 'pick', array[${release}::uuid], ${release}, 0.05, 'mb_search', 0.955, 'p95')`;
    runningRun = await makeRun(lib, 'running', 7);
    await makePicks(lib, runningRun, 'p99', 3, 0.995);
    otherRun = await makeRun(otherLib, 'done', 9);
    await makePicks(otherLib, otherRun, 'p99', 3, 0.995);
    app = Fastify({ logger: false });
    await app.register(fastifyCookie);
    await registerApiRoutes(app, { backupService: { dir: '/nonexistent' } as never });
    await app.ready();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await handle?.close();
    await sql?.end({ timeout: 2 });
    const admin = postgres(adminUrl!, { max: 1, onnotice: () => undefined });
    if (db) await admin.unsafe(`drop database if exists ${db.name} with (force)`).catch(() => undefined);
    await admin.end({ timeout: 2 });
  });

  it('names the decider\'s own bands, most sure first', () => {
    expect([...BAND_IDS]).toEqual(JEV_SPEC.bands.map((b) => b.id));
  });

  it('needs library.edit, the library\'s own run and well-formed ids', async () => {
    expect((await call(listener, 'GET', `${runUrl()}/bands`)).statusCode).toBe(403);
    expect((await post(`${runUrl()}/spot-checks/draw`, { band: 'p99' }, listener)).statusCode).toBe(403);
    expect((await call(editor, 'GET', `${runUrl()}/bands`)).statusCode).toBe(200);
    // another library's run, an unknown run, malformed ids: not found
    for (const url of [runUrl(otherRun), runUrl(randomUUID()), runUrl('not-a-uuid'), runUrl(otherRun, otherLib).replace(otherLib, 'nope')]) {
      expect((await call(owner, 'GET', `${url}/bands`)).statusCode).toBe(404);
      expect((await call(owner, 'GET', `${url}/spot-checks`)).statusCode).toBe(404);
      expect((await post(`${url}/spot-checks/draw`, { band: 'p99' })).statusCode).toBe(404);
    }
    expect((await put(checkUrl('not-a-uuid'), { verdict: 'correct' })).statusCode).toBe(404);
    expect((await put(checkUrl(randomUUID()), { verdict: 'correct' })).statusCode).toBe(404);
    expect(await drawnIds('p99', otherRun)).toEqual([]);
  });

  it('refuses a band, a count or a verdict it does not know', async () => {
    expect((await draw('p50')).statusCode).toBe(400);
    expect((await draw('p99', 0)).statusCode).toBe(400);
    expect((await draw('p99', 101)).statusCode).toBe(400);
    expect((await post(`${runUrl()}/spot-checks/draw`, { band: 'p99', decisionId: randomUUID() })).statusCode).toBe(400);
    expect((await call(owner, 'GET', `${runUrl()}/spot-checks?verdict=maybe`)).statusCode).toBe(400);
    expect((await call(owner, 'GET', `${runUrl()}/spot-checks?limit=101`)).statusCode).toBe(400);
    expect(await drawnIds('p99')).toEqual([]);
  });

  it('draws only from a run that has finished deciding', async () => {
    const r = await draw('p99', 3, runningRun);
    expect(r.statusCode).toBe(409);
    expect(await drawnIds('p99', runningRun)).toEqual([]);
  });

  it('off: no draw and no verdict, the band table still reads', async () => {
    await setAutotaggerEnabled(sql, false);
    try {
      expect((await draw('p99')).statusCode).toBe(409);
      expect((await put(checkUrl(randomUUID()), { verdict: 'correct' })).statusCode).toBe(409);
      expect((await call(owner, 'GET', `${runUrl()}/bands`)).statusCode).toBe(200);
    } finally {
      await setAutotaggerEnabled(sql, true);
    }
  });

  it('draws random picks of one band, never twice', async () => {
    const a = await draw('p99', 25);
    const b = await draw('p99', 25);
    expect(a.statusCode).toBe(200);
    expect(a.json().drawn + b.json().drawn).toBe(Math.min(50, PICKS_P99));
    const [{ n, d }] = await sql`select count(*)::int as n, count(distinct decision_id)::int as d from decider_spot_checks where run_id = ${run}` as unknown as [{ n: number; d: number }];
    expect(n).toBe(d);
    expect(n).toBe(50);
    // a band with fewer picks left than asked gives what it has
    expect((await draw('p97', 25)).json().drawn).toBe(PICKS_P97);
    // a band with no pick left draws nothing
    expect((await draw('p97', 5)).json().drawn).toBe(0);
    expect(await drawnIds('p97')).toHaveLength(PICKS_P97);
  });

  it('the draw is not the first rows by id (it is random), and follows the run\'s seeded order', async () => {
    const drawn = new Set(await drawnIds('p99'));
    const firstById = await sql<Array<{ id: string }>>`
      select id::text as id from decider_decisions where run_id = ${run} and band = 'p99' order by local_album_id limit 50`;
    expect(firstById.filter((r) => drawn.has(r.id)).length).toBeLessThan(50);
    // exactly the first 50 of the run's shuffled order: uniform, reproducible, without replacement
    expect([...drawn].sort()).toEqual((await shuffled('p99')).slice(0, 50).sort());
  });

  it('two draws at once take different picks, the next ones in order', async () => {
    // with no count, 25
    const [a, b] = await Promise.all([draw('p99'), draw('p99', 10)]);
    expect(a.json().drawn).toBe(25);
    expect(b.json().drawn).toBe(10);
    const drawn = await drawnIds('p99');
    expect(new Set(drawn).size).toBe(drawn.length);
    expect([...drawn].sort()).toEqual((await shuffled('p99')).slice(0, 85).sort());
  });

  it('lists checks in the order drawn, filtered by band and verdict', async () => {
    const all = await get(`${runUrl()}/spot-checks?band=p99&verdict=pending&limit=100`);
    expect(all).toHaveLength(85);
    const order = await shuffled('p99');
    const byDecision = new Map((await sql<Array<{ id: string; decision_id: string }>>`
      select id::text as id, decision_id::text as decision_id from decider_spot_checks where run_id = ${run}`).map((r) => [r.id, r.decision_id]));
    const positions = all.map((c: { id: string }) => order.indexOf(byDecision.get(c.id)!));
    // every draw took the next picks of the shuffled order, and they list so
    expect(positions).toEqual([...positions].sort((x: number, y: number) => x - y));
    const page = await get(`${runUrl()}/spot-checks?band=p99&limit=10&offset=60`);
    expect(page.map((c: { id: string }) => c.id)).toEqual(all.slice(60, 70).map((c: { id: string }) => c.id));
    expect(await get(`${runUrl()}/spot-checks?band=p95`)).toEqual([]);
    expect(await get(`${runUrl()}/spot-checks?band=p99&verdict=correct`)).toEqual([]);
  });

  it('the band table counts verdicts and opens the gate at 299 clean checks', async () => {
    await markAll(run, 'p99', 298, 'correct');
    expect((await bands())[0]).toMatchObject({ band: 'p99', picks: PICKS_P99, checked: 298, errors: 0, unsure: 0, allowed: false, stillNeeded: 1 });
    await markAll(run, 'p99', 1, 'correct');
    const [p99] = await bands();
    expect(p99).toMatchObject({ band: 'p99', checked: 299, allowed: true, stillNeeded: 0 });
    expect(p99.upper).toBeLessThanOrEqual(0.01);
    expect(p99.drawn).toBeGreaterThanOrEqual(299);
  });

  it('unsure does not count; wrong does', async () => {
    await markAll(run, 'p97', 5, 'unsure');
    await markAll(run, 'p97', 1, 'wrong');
    const p97 = (await bands()).find((b: { band: string }) => b.band === 'p97');
    expect(p97).toMatchObject({ checked: 1, errors: 1, unsure: 5, drawn: PICKS_P97, allowed: false, upper: 1 });
    expect(p97.stillNeeded === null || p97.stillNeeded > 299).toBe(true);
  });

  it('a later verdict replaces the earlier one, with who gave it and when', async () => {
    const [wrong] = await get(`${runUrl()}/spot-checks?band=p97&verdict=wrong`);
    expect((await put(checkUrl(wrong.id), { verdict: 'correct' }, editor)).statusCode).toBe(204);
    const [row] = await sql<Array<{ verdict: string; checked_by_user_id: string; checked_at: string | null }>>`
      select verdict, checked_by_user_id::text as checked_by_user_id, checked_at from decider_spot_checks where id = ${wrong.id}`;
    expect(row).toMatchObject({ verdict: 'correct', checked_by_user_id: editor.userId });
    expect(row!.checked_at).not.toBeNull();
    expect((await bands()).find((b: { band: string }) => b.band === 'p97')).toMatchObject({ checked: 1, errors: 0, unsure: 5 });
    const [unsure] = await get(`${runUrl()}/spot-checks?band=p97&verdict=unsure`);
    expect((await put(checkUrl(unsure.id), { verdict: 'wrong' })).statusCode).toBe(204);
    expect((await bands()).find((b: { band: string }) => b.band === 'p97')).toMatchObject({ checked: 2, errors: 1, unsure: 4 });
    // back to pending is not a verdict; a check of another library's run is not found
    expect((await put(checkUrl(unsure.id), { verdict: 'pending' })).statusCode).toBe(400);
    expect((await put(checkUrl(unsure.id, otherLib), { verdict: 'correct' })).statusCode).toBe(404);
    expect((await sql`select verdict from decider_spot_checks where id = ${unsure.id}`)[0]).toMatchObject({ verdict: 'wrong' });
  });

  it('a check shows the owner\'s files beside the chosen edition', async () => {
    expect((await draw('p99', 1)).json().drawn).toBe(1);
    const [item] = await get(`${runUrl()}/spot-checks?band=p99&verdict=pending&limit=1`);
    expect(item.album.tracks.length).toBeGreaterThan(0);
    expect(item.chosen.tracks.length).toBeGreaterThan(0);
    expect(item).toMatchObject({
      band: 'p99', verdict: 'pending', probability: 0.995, groupSize: 2,
      album: { artist: 'Kuunvalo', year: 2001 },
      chosen: { releaseId: release, title: 'Albumi (remaster)', year: 2001, country: 'FI', label: 'Levy-yhtiö · LY-001', format: 'CD', source: 'musicbrainz' },
    });
    expect(item.album.title).toMatch(/^Albumi \d+$/);
    // the owner's own titles, a file-name title too (no request placeholders on their own screen)
    expect(item.album.tracks).toEqual([
      { n: 1, title: 'Ilta', length: '3:20' }, { n: 2, title: '02 oma tiedosto', length: '3:30' }, { n: 3, title: 'Yö', length: null },
    ]);
    expect(item.chosen.tracks).toEqual([
      { n: 1, title: 'Ilta', length: '3:20' }, { n: 2, title: 'Toinen', length: '3:30' }, { n: 3, title: 'Yö', length: '3:40' },
    ]);
  });

  it('an album without stored evidence shows its tracks as scanned', async () => {
    expect((await draw('p95', 5)).json().drawn).toBe(1);
    const [item] = await get(`${runUrl()}/spot-checks?band=p95`);
    expect(item.album).toMatchObject({ id: scannedAlbum, title: 'Skannattu', year: null });
    expect(item.album.tracks).toEqual([{ n: 1, title: 'Yksi', length: '2:02' }, { n: 2, title: 'Kaksi', length: '1:01' }]);
    expect((await bands()).map((b: { band: string }) => b.band)).toEqual(['p99', 'p97', 'p95']);
  });

  it('counts the picks already accepted by one of the run\'s model batches', async () => {
    const [p99before] = await bands();
    expect(p99before.accepted).toBe(0);
    const albums = await sql<Array<{ id: string }>>`
      select local_album_id::text as id from decider_decisions where run_id = ${run} and band = 'p99' order by id limit 3`;
    const batch = async (kind: string, runId: string | null) => (await sql<Array<{ id: string }>>`
      insert into decider_batches (library_id, decider_id, decided_kind, run_id, band, state) values (${lib}, 'jev', ${kind}, ${runId}, 'p99', 'accepted')
      returning id::text as id`)[0]!.id;
    const model = await batch('model', run);
    const rules = await batch('rule', null);
    const otherRunBatch = await batch('model', runningRun);
    const item = (b: string, album: string, status: string, pos: number) => sql`
      insert into decider_batch_items (batch_id, position, local_album_id, release_id, distance, reason, status, skip_reason)
      values (${b}, ${pos}, ${album}, ${release}, 0.05, 'test', ${status}, ${status === 'skipped' ? 'state' : null})`;
    await item(model, albums[0]!.id, 'accepted', 0);
    await item(model, albums[1]!.id, 'skipped', 1);
    await item(model, albums[2]!.id, 'undone', 2);
    await item(rules, albums[1]!.id, 'accepted', 0);
    await item(otherRunBatch, albums[2]!.id, 'accepted', 0);
    const [p99] = await bands();
    expect(p99.accepted).toBe(1);
  });
});
