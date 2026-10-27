/**
 * Decider runs and the payload preview against the real server on a scratch
 * database (the module switch is install-wide, so it is never flipped on the
 * shared test database): the preview shows exactly the request a run sends
 * for an album, with placeholders and no paths; no run starts before the
 * owner has seen it, or without a key, a cap or a price, or beside another
 * run of the library; runs are listed, resumed and cancelled. Nothing is
 * sent anywhere: pg-boss is a stand-in.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import postgres from 'postgres';
import { loadEvidence, setAutotaggerEnabled, setTypesafeKey, syncInstalledModules, upsertAlbumEvidence } from '@tagave/db';
import { ledgerEntries } from '@tagave/core/facets';
import {
  buildAlbumEvidence, buildCandidateEvidence, requestForAlbum, sealSecret, type AlbumEvidence, type CandidateEvidence,
} from '@tagave/core';
import type { AuthHandle } from '@tagave/auth';

const bossSend = vi.fn(async (..._args: unknown[]): Promise<string | null> => 'job');
const bossCancel = vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined);
vi.mock('../boss.js', () => ({ getBoss: async () => ({ send: bossSend, cancel: bossCancel }) }));

const { registerApiRoutes } = await import('../app.js');
const { initAuth } = await import('../middleware/auth.js');
const { TEST_APP_SECRET, TEST_PUBLIC_URL, createScratchDb, migrateAll, testAuth } = await import('../testkit/authApp.js');
const { createTestUser } = await import('../testkit/users.js');
const { initDb } = await import('../db.js');
type TestUser = Awaited<ReturnType<typeof createTestUser>>;

const adminUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!adminUrl)('autotagger runs and payload preview (integration, scratch db)', () => {
  let db: { url: string; name: string };
  let sql: postgres.Sql;
  let handle: AuthHandle;
  let app: FastifyInstance;
  let owner: TestUser;
  let editor: TestUser;
  let lib = '';
  let emptyLib = '';
  let rg = '';
  let oneGroup = '', twoGroups = '', folderTitled = '', weakAlbum = '', otherLibAlbum = '';
  const albumFolder = `Musik/zz-private-folder-${randomUUID().slice(0, 8)}`;

  const call = async (u: TestUser, method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: object) =>
    app.inject({ method, url, headers: { cookie: u.cookie, origin: TEST_PUBLIC_URL }, ...(payload ? { payload } : {}) });
  const get = async (url: string) => (await call(owner, 'GET', url)).json();
  const getR = (url: string, u: TestUser = owner) => call(u, 'GET', url);
  const post = (url: string, body: object, u: TestUser = owner) => call(u, 'POST', url, body);
  const patch = (url: string, body: object) => call(owner, 'PATCH', url, body);
  const put = (url: string, body: object) => call(owner, 'PUT', url, body);

  /** An album with stored evidence and its candidates (each a tracklist of its own titles). */
  async function makeAlbum(libraryId: string, o: {
    title: string; tracks: Array<{ title: string; from?: 'tag' | 'filename' }>; candidates: Array<{ distance: number; titles: string[] }>;
    state?: string; identifyReason?: string | null; titleSource?: 'tag' | 'folder'; id?: string;
  }): Promise<string> {
    const id = o.id ?? randomUUID();
    await sql`insert into local_albums (id, library_id, cluster_key, dir_paths, title_guess, artist_guess, state, identify_reason, track_count, title_source, last_identify_at)
              values (${id}, ${libraryId}, ${'k-' + id}, ${[`${albumFolder}/${id}`]}, ${o.title}, 'Kuunvalo', ${o.state ?? 'needs_review'},
                      ${o.identifyReason ?? 'close call'}, ${o.tracks.length}, ${o.titleSource ?? 'tag'}, now())`;
    const album = buildAlbumEvidence({
      artist: 'Kuunvalo', title: o.title, titleSource: o.titleSource ?? 'tag', year: 2001, yearSource: 'tag', discsKnown: false, discCount: null,
      tracks: o.tracks.map((t, i) => ({ title: t.title, titleSource: t.from ?? 'tag', duration: 200 + i * 10 })),
    });
    await upsertAlbumEvidence(sql, id, album);
    for (const c of o.candidates) {
      const rid = randomUUID();
      await sql`insert into releases (id, release_group_id, mbid, title, status, track_count, source_of_truth)
                values (${rid}, ${rg}, ${randomUUID()}, ${o.title}, 'Official', ${c.titles.length}, 'musicbrainz')`;
      const shared = Math.min(o.tracks.length, c.titles.length);
      const ev = buildCandidateEvidence(
        { source: 'musicbrainz', title: o.title, artists: ['Kuunvalo'], status: 'Official', tracks: c.titles.map((t, i) => ({ title: t, duration: 200 + i * 10 })) },
        {
          alignment: o.tracks.map((_, i) => ({ localIndex: i, canonicalIndex: i < shared ? i : null, distance: 0.01, title: { local: '' }, duration: { local: 0 } })),
          missingRemote: c.titles.map((_, i) => i).filter((i) => i >= shared),
        },
        o.tracks.length);
      await sql`insert into match_candidates (local_album_id, release_id, distance, breakdown, source, evidence)
                values (${id}, ${rid}, ${c.distance}, '{}'::jsonb, 'mb_search', ${JSON.stringify(ev)}::text::jsonb)`;
    }
    return id;
  }

  const runs = (l = lib) => `/api/v1/libraries/${l}/autotagger/runs`;
  const runState = async (id: string) => (await sql<Array<{ state: string }>>`select state from decider_runs where id = ${id}`)[0]?.state;
  /** Ready to run: on, a key, the payload seen, a cap and a price. */
  async function ready(): Promise<void> {
    await setAutotaggerEnabled(sql, true);
    await setTypesafeKey(sql, lib, sealSecret('ts-live-0123456789abcdef', TEST_APP_SECRET), 'cdef');
    await post(`/api/v1/libraries/${lib}/autotagger/preview/seen`, {});
    await patch(`/api/v1/libraries/${lib}/autotagger/config`, { monthlyCap: 5, currency: 'USD' });
    await put('/api/v1/settings/autotagger/prices', { model: '*', perMillionInput: 1, currency: 'USD' });
  }

  beforeAll(async () => {
    const admin = postgres(adminUrl!, { max: 1, onnotice: () => undefined });
    db = await createScratchDb(adminUrl!, admin);
    await admin.end({ timeout: 2 });
    await migrateAll(db.url);
    await initDb(db.url);
    handle = testAuth(db.url);
    initAuth(handle);
    sql = postgres(db.url, { max: 2, onnotice: () => undefined });
    await syncInstalledModules(sql, ledgerEntries());
    // the columns of pg-boss's job table the routes read (this database has no pg-boss)
    await sql`create schema if not exists pgboss`;
    await sql`create table if not exists pgboss.job (id uuid primary key default gen_random_uuid(), name text not null, singleton_key text, state text not null, data jsonb)`;
    owner = await createTestUser(handle, { role: 'owner', name: 'Ada' });
    editor = await createTestUser(handle, { role: 'editor' });
    const [l] = await sql<Array<{ id: string }>>`insert into libraries (owner_user_id, name, settings) values (${owner.userId}, 'Music', '{}'::jsonb) returning id::text as id`;
    lib = l!.id;
    const [e] = await sql<Array<{ id: string }>>`insert into libraries (owner_user_id, name, settings) values (${owner.userId}, 'Empty', '{}'::jsonb) returning id::text as id`;
    emptyLib = e!.id;
    rg = randomUUID();
    await sql`insert into release_groups (id, mbid, title, artist_credit) values (${rg}, ${randomUUID()}, 'Kuunvalo', ${JSON.stringify(['Kuunvalo'])}::text::jsonb)`;
    const three = ['Ilta', 'Aamu', 'Yö'];
    // ids decide the preview's order: the one-group album sorts first
    const [firstId, secondId] = [randomUUID(), randomUUID()].sort() as [string, string];
    oneGroup = await makeAlbum(lib, { id: firstId, title: 'Yksi', tracks: three.map((t) => ({ title: t })), candidates: [{ distance: 0.05, titles: three }] });
    twoGroups = await makeAlbum(lib, {
      id: secondId, title: 'Kaksi', tracks: [{ title: 'Ilta' }, { title: '02 zz-private-file-name', from: 'filename' }, { title: 'Yö' }],
      candidates: [{ distance: 0.05, titles: three }, { distance: 0.2, titles: [...three, 'Bonus'] }],
    });
    folderTitled = await makeAlbum(lib, { title: 'Kansio', titleSource: 'folder', tracks: three.map((t) => ({ title: t })), candidates: [{ distance: 0.05, titles: three }] });
    weakAlbum = await makeAlbum(lib, {
      title: 'Heikko', state: 'unidentified', identifyReason: 'weak_candidates', tracks: three.map((t) => ({ title: t })),
      candidates: Array.from({ length: 7 }, (_, k) => ({ distance: 0.3 + k * 0.05, titles: Array.from({ length: k + 1 }, (_, j) => `Osa ${j + 1}`) })),
    });
    const [other] = await sql<Array<{ id: string }>>`insert into libraries (owner_user_id, name, settings) values (${owner.userId}, 'Other', '{}'::jsonb) returning id::text as id`;
    otherLibAlbum = await makeAlbum(other!.id, { title: 'Muu', tracks: three.map((t) => ({ title: t })), candidates: [{ distance: 0.05, titles: three }] });
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

  /** pg-boss's stately send on the stand-in job table: one waiting job per key, else null. */
  const statelySend = async (...args: unknown[]): Promise<string | null> => {
    const [name, data, opts] = args as [string, object, { singletonKey: string }];
    const [waiting] = await sql`select 1 as x from pgboss.job where name = ${name} and singleton_key = ${opts.singletonKey} and state in ('created', 'retry')`;
    if (waiting) return null;
    const [job] = await sql<Array<{ id: string }>>`
      insert into pgboss.job (name, singleton_key, state, data) values (${name}, ${opts.singletonKey}, 'created', ${JSON.stringify(data)}::text::jsonb) returning id::text as id`;
    return job!.id;
  };

  beforeEach(async () => {
    bossSend.mockReset();
    bossSend.mockImplementation(async () => 'job');
    bossCancel.mockReset();
    bossCancel.mockImplementation(async (...args: unknown[]) => {
      const ids = args[1] as string[];
      await sql`update pgboss.job set state = 'cancelled' where id = any(${ids}::uuid[])`;
    });
    await sql`delete from pgboss.job`;
    await setAutotaggerEnabled(sql, true);
  });

  it('the preview and its seen mark need the module on and the owner', async () => {
    await setAutotaggerEnabled(sql, false);
    expect((await getR(`/api/v1/libraries/${lib}/autotagger/preview`)).statusCode).toBe(409);
    expect((await post(`/api/v1/libraries/${lib}/autotagger/preview/seen`, {})).statusCode).toBe(409);
    await setAutotaggerEnabled(sql, true);
    expect((await getR(`/api/v1/libraries/${lib}/autotagger/preview`, editor)).statusCode).toBe(403);
    expect((await post(`/api/v1/libraries/${lib}/autotagger/preview/seen`, {}, editor)).statusCode).toBe(403);
    expect((await getR(`/api/v1/libraries/${randomUUID()}/autotagger/preview`)).statusCode).toBe(404);
    expect((await getR('/api/v1/libraries/not-a-uuid/autotagger/preview')).statusCode).toBe(404);
  });

  it('shows the exact request for one album, with placeholders and no paths', async () => {
    const p = await get(`/api/v1/libraries/${lib}/autotagger/preview`);
    expect(p.request.questions).toHaveProperty('is_A');
    expect(JSON.stringify(p.request)).not.toContain(albumFolder);
    expect(p.bytes).toBe(Buffer.byteLength(JSON.stringify(p.request), 'utf8'));
    // the first album in review whose request has two groups
    expect(p).toMatchObject({ albumId: twoGroups, title: 'Kaksi', artist: 'Kuunvalo', groups: 2 });
    expect(p.request.model).toBe('jev-latest');
    expect(p.request.state.local.tracks[1].title).toBe('track 2');
    expect(JSON.stringify(p)).not.toMatch(/zz-private|Musik\/|ts-live/);
    // the very request a run makes from the album's evidence
    const ev = (await loadEvidence<AlbumEvidence, CandidateEvidence>(sql, twoGroups))!;
    expect(p.request).toEqual(JSON.parse(JSON.stringify(requestForAlbum(ev.album, ev.candidates, { model: 'jev-latest' }).request)));
  });

  it('an album asked for by id: as the run would send it, or refused', async () => {
    const one = await get(`/api/v1/libraries/${lib}/autotagger/preview?albumId=${oneGroup}`);
    expect(one).toMatchObject({ albumId: oneGroup, groups: 1 });
    // a weak album sends its best five candidates only, as its run does
    const weak = await get(`/api/v1/libraries/${lib}/autotagger/preview?albumId=${weakAlbum}`);
    expect(weak.groups).toBe(5);
    expect((await getR(`/api/v1/libraries/${lib}/autotagger/preview?albumId=${folderTitled}`)).statusCode).toBe(409);
    expect((await getR(`/api/v1/libraries/${lib}/autotagger/preview?albumId=${otherLibAlbum}`)).statusCode).toBe(404);
    expect((await getR(`/api/v1/libraries/${lib}/autotagger/preview?albumId=nope`)).statusCode).toBe(404);
    // a library with no album to show
    expect((await getR(`/api/v1/libraries/${emptyLib}/autotagger/preview`)).statusCode).toBe(404);
  });

  it('a request over the library\'s byte limit is not shown, as it is not sent', async () => {
    await patch(`/api/v1/libraries/${lib}/autotagger/config`, { maxRequestBytes: 1024 });
    try {
      const r = await getR(`/api/v1/libraries/${lib}/autotagger/preview?albumId=${twoGroups}`);
      expect(r.statusCode).toBe(409);
      expect(r.json().detail).toMatch(/too_large/);
    } finally {
      await patch(`/api/v1/libraries/${lib}/autotagger/config`, { maxRequestBytes: null });
    }
  });

  it('no run before the owner has seen the payload', async () => {
    await setTypesafeKey(sql, lib, sealSecret('ts-live-0123456789abcdef', TEST_APP_SECRET), 'cdef');
    const r = await post(runs(), { population: 'needs_review' });
    expect(r.statusCode).toBe(409);
    expect(r.json().detail).toMatch(/payload/i);
    expect(bossSend).not.toHaveBeenCalled();
  });

  it('marks the payload seen, by whom, with an audit row that holds no payload', async () => {
    const r = await post(`/api/v1/libraries/${lib}/autotagger/preview/seen`, {});
    expect(r.statusCode).toBe(200);
    expect(r.json().config.payloadSeenBy).toBe(owner.userId);
    expect(r.json().config.payloadSeenAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const audit = await sql<Array<{ payload: unknown; subject_id: string }>>`
      select payload, subject_id::text from audit_log where action = 'autotagger.payload_seen' and library_id = ${lib}`;
    expect(audit).toHaveLength(1);
    expect(audit[0]!.subject_id).toBe(lib);
    expect(JSON.stringify(audit[0]!.payload ?? null)).not.toMatch(/Kuunvalo|questions/);
  });

  it('refuses to start without a cap, without a price, or with a price in another currency', async () => {
    let r = await post(runs(), { population: 'needs_review' });
    expect(r.statusCode).toBe(409);
    expect(r.json().detail).toMatch(/cap/i);
    await patch(`/api/v1/libraries/${lib}/autotagger/config`, { monthlyCap: 5 });
    r = await post(runs(), { population: 'needs_review' });
    expect(r.statusCode).toBe(409);
    expect(r.json().detail).toMatch(/price/i);
    await put('/api/v1/settings/autotagger/prices', { model: '*', perMillionInput: 1, currency: 'EUR' });
    r = await post(runs(), { population: 'needs_review' });
    expect(r.statusCode).toBe(409);
    expect(r.json().detail).toMatch(/EUR/);
    expect(bossSend).not.toHaveBeenCalled();
  });

  it('starts a run once seen, with a cap and a price, and only one at a time', async () => {
    await post(`/api/v1/libraries/${lib}/autotagger/preview/seen`, {});
    await patch(`/api/v1/libraries/${lib}/autotagger/config`, { monthlyCap: 5 });
    await put('/api/v1/settings/autotagger/prices', { model: '*', perMillionInput: 1, currency: 'USD' });
    const r = await post(runs(), { population: 'needs_review' });
    expect(r.statusCode).toBe(202);
    expect(bossSend).toHaveBeenCalledWith('decider.run', { runId: r.json().id }, { singletonKey: `decider.run:${lib}` });
    expect(r.json()).toMatchObject({
      population: 'needs_review', state: 'queued', pauseReason: null, modelLabel: 'Jev', albums: 2, outcomes: {}, spent: 0, spentOther: [], currency: 'USD', projected: null,
    });
    expect((await post(runs(), { population: 'weak' })).statusCode).toBe(409);
    const [row] = await sql<Array<{ started_by_user_id: string; model_requested: string }>>`
      select started_by_user_id::text, model_requested from decider_runs where id = ${r.json().id}`;
    expect(row).toEqual({ started_by_user_id: owner.userId, model_requested: 'jev-latest' });
    await post(`${runs()}/${r.json().id}/cancel`, {});
  });

  it('nothing schedules a run: there is no schedule for decider.run', async () => {
    const src = await readFile(new URL('../../../worker/src/index.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/schedule\('decider\.run'/);
  });

  it('a measure run cannot be started from the API', async () => {
    expect((await post(runs(), { population: 'measure' })).statusCode).toBe(400);
    expect((await post(runs(), {})).statusCode).toBe(400);
    expect((await post(runs(), { population: 'needs_review', extra: 1 })).statusCode).toBe(400);
  });

  it('a start pg-boss did not queue is a 503, and the run does not block the next', async () => {
    await ready();
    bossSend.mockImplementation(async () => null);
    const r = await post(runs(), { population: 'needs_review' });
    expect(r.statusCode).toBe(503);
    const [failed] = await sql<Array<{ state: string; message: string }>>`
      select state, message from decider_runs where library_id = ${lib} order by created_at desc limit 1`;
    expect(failed).toEqual({ state: 'failed', message: 'not queued' });
    // pg-boss not answering at all: the same
    bossSend.mockImplementation(async () => { throw new Error('connection refused'); });
    expect((await post(runs(), { population: 'needs_review' })).statusCode).toBe(503);
    bossSend.mockImplementation(async () => 'job');
    const again = await post(runs(), { population: 'needs_review' });
    expect(again.statusCode).toBe(202);
    await post(`${runs()}/${again.json().id}/cancel`, {});
  });

  it('lists runs for editors, with outcomes, spend in the settings currency and the projection', async () => {
    await ready();
    const started = (await post(runs(), { population: 'needs_review' })).json();
    // a call answered and one decision, as the worker records them; and a call in another currency
    const [c] = await sql<Array<{ id: string }>>`
      insert into decider_calls (library_id, local_album_id, run_id, evidence_hash, spec_hash, decider_id, decider_version, request_bytes, input_tokens, cost, currency, answers)
      values (${lib}, ${twoGroups}, ${started.id}, ${'a'.repeat(64)}, 'x', 'jev', 'jev-2026-09-15', 4000, 1000, 0.002, 'USD', '{"A": 0.99}'::jsonb) returning id`;
    await sql`insert into decider_calls (library_id, local_album_id, run_id, evidence_hash, spec_hash, decider_id, decider_version, request_bytes, input_tokens, cost, currency, answers)
              values (${lib}, ${oneGroup}, ${started.id}, ${'b'.repeat(64)}, 'x', 'jev', 'jev-2026-09-15', 4000, 1000, 7, 'EUR', '{"A": 0.99}'::jsonb)`;
    await sql`update decider_runs set state = 'running', decider_version = 'jev-2026-09-15' where id = ${started.id}`;
    await sql`insert into decider_decisions (run_id, local_album_id, call_id, outcome, group_label, probability, band)
              values (${started.id}, ${twoGroups}, ${c!.id}, 'pick', 'A', 0.99, 'high')`;
    const list = await getR(runs(), editor);
    expect(list.statusCode).toBe(200);
    const view = list.json().items[0];
    expect(view).toMatchObject({
      id: started.id, state: 'running', modelLabel: 'Jev 2026-09', albums: 2, outcomes: { pick: 1 }, spent: 0.002, currency: 'USD',
      // never added to the USD figure, never hidden either
      spentOther: [{ currency: 'EUR', amount: 7 }],
    });
    expect(view.projected).toBeCloseTo(0.004, 6);
    expect(view.startedBy).toBe('Ada');
    expect(new Date(view.createdAt).toISOString()).toBe(view.createdAt);
    expect((await getR(`${runs()}/${started.id}`, editor)).json()).toEqual(view);
    expect((await getR(`${runs()}/${randomUUID()}`)).statusCode).toBe(404);
    expect((await getR(`${runs()}/not-a-uuid`)).statusCode).toBe(404);
    // an editor reads, never starts, resumes or cancels
    expect((await post(runs(), { population: 'needs_review' }, editor)).statusCode).toBe(403);
    expect((await post(`${runs()}/${started.id}/cancel`, {}, editor)).statusCode).toBe(403);
    expect((await post(`${runs()}/${started.id}/resume`, {}, editor)).statusCode).toBe(403);
    await post(`${runs()}/${started.id}/cancel`, {});
  });

  it('resumes a paused run with its own job, and cancels a run', async () => {
    await ready();
    const started = (await post(runs(), { population: 'needs_review' })).json();
    // a running run is not resumed: its job is working it
    await sql`update decider_runs set state = 'running' where id = ${started.id}`;
    expect((await post(`${runs()}/${started.id}/resume`, {})).statusCode).toBe(409);
    await sql`update decider_runs set state = 'paused', pause_reason = 'cap_reached', message = 'spent 5.0000 of 5 USD' where id = ${started.id}`;
    const paused = (await getR(`${runs()}/${started.id}`)).json();
    expect(paused).toMatchObject({ state: 'paused', pauseReason: 'cap_reached', message: 'spent 5.0000 of 5 USD' });
    // another run cannot start beside a paused one
    expect((await post(runs(), { population: 'weak' })).statusCode).toBe(409);
    bossSend.mockClear();
    const resumed = await post(`${runs()}/${started.id}/resume`, {});
    expect(resumed.statusCode).toBe(202);
    expect(resumed.json()).toMatchObject({ state: 'queued', pauseReason: null, message: null });
    expect(bossSend).toHaveBeenCalledWith('decider.run', { runId: started.id }, { singletonKey: `decider.run:${lib}` });
    const cancelled = await post(`${runs()}/${started.id}/cancel`, {});
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().state).toBe('cancelled');
    expect(await runState(started.id)).toBe('cancelled');
    expect((await post(`${runs()}/${started.id}/cancel`, {})).statusCode).toBe(409);
    expect((await post(`${runs()}/${started.id}/resume`, {})).statusCode).toBe(409);
    // a run whose question spec changed is not resumed: a new run asks the new question
    const next = (await post(runs(), { population: 'needs_review' })).json();
    await sql`update decider_runs set state = 'paused', pause_reason = 'spec_changed', spec_hash = 'tagave-tracklist-v0@000000000000' where id = ${next.id}`;
    expect((await post(`${runs()}/${next.id}/resume`, {})).statusCode).toBe(409);
    await post(`${runs()}/${next.id}/cancel`, {});
  });

  it('a resume pg-boss did not queue: fine when the run\'s own job waits, else a 503 that leaves it paused', async () => {
    await ready();
    const started = (await post(runs(), { population: 'needs_review' })).json();
    await sql`update decider_runs set state = 'paused', pause_reason = 'module_off' where id = ${started.id}`;
    bossSend.mockImplementation(async () => null);
    // the run's own job still waits (the worker has not reached it): resumed
    await sql`insert into pgboss.job (name, singleton_key, state, data)
              values ('decider.run', ${`decider.run:${lib}`}, 'created', ${JSON.stringify({ runId: started.id })}::text::jsonb)`;
    expect((await post(`${runs()}/${started.id}/resume`, {})).statusCode).toBe(202);
    expect(await runState(started.id)).toBe('queued');
    await sql`update decider_runs set state = 'paused', pause_reason = 'module_off' where id = ${started.id}`;
    // a job for another run waits: this one would never be worked
    await sql`update pgboss.job set data = ${JSON.stringify({ runId: randomUUID() })}::text::jsonb where singleton_key = ${`decider.run:${lib}`}`;
    const r = await post(`${runs()}/${started.id}/resume`, {});
    expect(r.statusCode).toBe(503);
    expect(await runState(started.id)).toBe('paused');
    await sql`delete from pgboss.job where singleton_key = ${`decider.run:${lib}`}`;
    await post(`${runs()}/${started.id}/cancel`, {});
  });

  it('a paused run can be cancelled', async () => {
    await ready();
    const started = (await post(runs(), { population: 'needs_review' })).json();
    await sql`update decider_runs set state = 'paused', pause_reason = 'cap_reached' where id = ${started.id}`;
    const r = await post(`${runs()}/${started.id}/cancel`, {});
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ id: started.id, state: 'cancelled' });
  });

  it('a run cancelled while queued takes its waiting job with it, so the next start is queued', async () => {
    await ready();
    bossSend.mockImplementation(statelySend);
    const first = await post(runs(), { population: 'needs_review' });
    expect(first.statusCode).toBe(202);
    expect((await post(`${runs()}/${first.json().id}/cancel`, {})).statusCode).toBe(200);
    expect(bossCancel).toHaveBeenCalledTimes(1);
    const [job] = await sql<Array<{ state: string }>>`select state from pgboss.job where data->>'runId' = ${first.json().id}`;
    expect(job!.state).toBe('cancelled');
    const second = await post(runs(), { population: 'needs_review' });
    expect(second.statusCode).toBe(202);

    // the cancel could not reach pg-boss: the job of the ended run is cancelled by the next start
    bossCancel.mockImplementationOnce(async () => { throw new Error('connection refused'); });
    expect((await post(`${runs()}/${second.json().id}/cancel`, {})).statusCode).toBe(200);
    const [left] = await sql<Array<{ state: string }>>`select state from pgboss.job where data->>'runId' = ${second.json().id}`;
    expect(left!.state).toBe('created');
    const third = await post(runs(), { population: 'needs_review' });
    expect(third.statusCode).toBe(202);
    const states = await sql<Array<{ run: string; state: string }>>`select data->>'runId' as run, state from pgboss.job where state = 'created'`;
    expect(states).toEqual([{ run: third.json().id, state: 'created' }]);
    await post(`${runs()}/${third.json().id}/cancel`, {});
  });
});
