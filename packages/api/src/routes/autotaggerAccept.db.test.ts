/**
 * Accepting a band of a finished run, and the local decider's routes,
 * against the real server on a scratch database (the module switch is
 * install-wide, so it is never flipped on the shared test database):
 *
 *   accept    only through the band's spot-check gate; the batch leaves out
 *             picks checked wrong or unsure and picks already in a batch of
 *             the run; a backtest is never accepted; the owner's only.
 *   local     a run of the local decider needs the trained model and nothing
 *             else (no key, payload seen, price or cap); Jev needs a key;
 *             training is queued; the models are listed, active first.
 *
 * Nothing is sent anywhere: pg-boss is a stand-in.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import postgres from 'postgres';
import { BATCH_CANNOT_UNDO, setAutotaggerEnabled, storeModel, syncInstalledModules } from '@tagave/db';
import { ledgerEntries } from '@tagave/core/facets';
import type { AuthHandle } from '@tagave/auth';

const send = vi.hoisted(() => vi.fn(async (..._args: unknown[]): Promise<string | null> => 'job'));
vi.mock('../boss.js', () => ({ getBoss: async () => ({ send, cancel: vi.fn(async () => undefined) }) }));

const { registerApiRoutes } = await import('../app.js');
const { initAuth } = await import('../middleware/auth.js');
const { TEST_PUBLIC_URL, createScratchDb, migrateAll, testAuth } = await import('../testkit/authApp.js');
const { createTestUser } = await import('../testkit/users.js');
const { initDb } = await import('../db.js');
type TestUser = Awaited<ReturnType<typeof createTestUser>>;

const adminUrl = process.env.TEST_DATABASE_URL;
const PICKS = 60;

describe.skipIf(!adminUrl)('autotagger: accept a band, the local decider (integration, scratch db)', () => {
  let db: { url: string; name: string };
  let sql: postgres.Sql;
  let handle: AuthHandle;
  let app: FastifyInstance;
  let owner: TestUser;
  let editor: TestUser;
  let lib = '';
  let run = '';
  let backtest = '';
  let release = '';

  const call = async (u: TestUser, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) =>
    app.inject({ method, url, headers: { cookie: u.cookie, origin: TEST_PUBLIC_URL }, ...(payload ? { payload } : {}) });
  const base = () => `/api/v1/libraries/${lib}/autotagger`;
  const runUrl = (r = run) => `${base()}/runs/${r}`;

  async function makeRun(population: string): Promise<string> {
    const [r] = await sql<Array<{ id: string }>>`
      insert into decider_runs (library_id, decider_id, spec_hash, model_requested, decider_version, population, state, seed, started_by_user_id, finished_at)
      values (${lib}, 'jev', 'tagave-tracklist-v1@000000000000', 'jev-latest', 'jev-2026-09-15', ${population}, 'done', 5, ${owner.userId}, now())
      returning id::text as id`;
    return r!.id;
  }

  async function makePicks(runId: string, band: string, n: number): Promise<string[]> {
    const albums = await sql<Array<{ id: string }>>`
      insert into local_albums (library_id, cluster_key, title_guess, artist_guess, state, identify_reason, track_count, last_identify_at)
      select ${lib}, 'k-' || gen_random_uuid(), 'Albumi ' || g, 'Kuunvalo', 'needs_review', 'close call', 3, now()
        from generate_series(1, ${n}) g
      returning id::text as id`;
    const ids = albums.map((a) => a.id);
    await sql`
      insert into decider_decisions (run_id, local_album_id, outcome, group_label, group_release_ids, release_id, distance, source, probability, margin, band, evidence_hash, last_identify_at)
      select ${runId}, id, 'pick', 'A', array[${release}::uuid], ${release}, 0.05, 'mb_search', 0.995, 0.6, ${band}, repeat('a', 64), now()
        from unnest(${ids}::uuid[]) as id`;
    return ids;
  }

  /** Draw `n` checks of the band through the route and give them this verdict. */
  async function check(band: string, n: number, verdict: 'correct' | 'wrong' | 'unsure'): Promise<void> {
    const d = await call(owner, 'POST', `${runUrl()}/spot-checks/draw`, { band, count: n });
    expect(d.statusCode).toBe(200);
    await sql`update decider_spot_checks set verdict = ${verdict}, checked_at = now(), checked_by_user_id = ${owner.userId}
               where run_id = ${run} and band = ${band} and verdict = 'pending'`;
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
    const [l] = await sql<Array<{ id: string }>>`insert into libraries (owner_user_id, name, settings) values (${owner.userId}, 'Music', '{}'::jsonb) returning id::text as id`;
    lib = l!.id;
    const rg = randomUUID();
    await sql`insert into release_groups (id, mbid, title, artist_credit) values (${rg}, ${randomUUID()}, 'Albumi', ${JSON.stringify(['Kuunvalo'])}::text::jsonb)`;
    release = randomUUID();
    await sql`insert into releases (id, release_group_id, mbid, title, status, track_count, source_of_truth)
              values (${release}, ${rg}, ${randomUUID()}, 'Albumi', 'Official', 3, 'musicbrainz')`;
    run = await makeRun('needs_review');
    await makePicks(run, 'p99', PICKS);
    backtest = await makeRun('backtest');
    await makePicks(backtest, 'p99', 3);
    app = Fastify({ logger: false });
    await app.register(fastifyCookie);
    await registerApiRoutes(app, { backupService: { dir: '/nonexistent' } as never });
    await app.ready();
    // a gate a small test can open: 20% (about 14 clean checks)
    expect((await call(owner, 'PATCH', `${base()}/config`, { maxErrorRate: 0.2 })).statusCode).toBe(200);
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await handle?.close();
    await sql?.end({ timeout: 2 });
    const admin = postgres(adminUrl!, { max: 1, onnotice: () => undefined });
    if (db) await admin.unsafe(`drop database if exists ${db.name} with (force)`).catch(() => undefined);
    await admin.end({ timeout: 2 });
  });

  it('is the owner\'s: an editor may neither preview nor accept', async () => {
    expect((await call(editor, 'GET', `${runUrl()}/accept-preview?band=p99`)).statusCode).toBe(403);
    expect((await call(editor, 'POST', `${runUrl()}/accept`, { band: 'p99' })).statusCode).toBe(403);
    expect((await call(owner, 'POST', `${runUrl()}/accept`, { band: 'p50' })).statusCode).toBe(400);
  });

  it('refuses a band whose gate is closed, and the preview says so', async () => {
    await check('p99', 5, 'correct');
    const p = (await call(owner, 'GET', `${runUrl()}/accept-preview?band=p99`)).json();
    expect(p).toMatchObject({ band: 'p99', albums: PICKS, excludedWrong: 0, alreadyAccepted: 0, notPinned: 0, gate: { allowed: false } });
    expect(p.cannotUndo).toEqual([...BATCH_CANNOT_UNDO]);
    expect(p).toHaveProperty('linkedApps', 0);
    expect(p.drain).toHaveProperty('nights');
    expect((await call(owner, 'POST', `${runUrl()}/accept`, { band: 'p99' })).statusCode).toBe(409);
  });

  it('accepts a band once the gate is open, leaving out the picks checked wrong or unsure', async () => {
    await check('p99', 1, 'wrong');
    await check('p99', 1, 'unsure');
    await check('p99', 30, 'correct');
    const preview = (await call(owner, 'GET', `${runUrl()}/accept-preview?band=p99`)).json();
    expect(preview).toMatchObject({ albums: PICKS - 2, excludedWrong: 2, gate: { allowed: true } });
    send.mockClear();
    const r = await call(owner, 'POST', `${runUrl()}/accept`, { band: 'p99' });
    expect(r.statusCode).toBe(202);
    const { batchId, albums } = r.json();
    expect(albums).toBe(PICKS - 2);
    expect(send).toHaveBeenCalledWith('decider.accept', { batchId, mode: 'accept' }, { singletonKey: `decider:${batchId}` });
    const [b] = await sql`select decider_id, decider_version, decided_kind, run_id::text as run_id, band, accept_from, state from decider_batches where id = ${batchId}`;
    expect(b).toEqual({ decider_id: 'jev', decider_version: 'jev-2026-09-15', decided_kind: 'model', run_id: run, band: 'p99', accept_from: ['needs_review'], state: 'queued' });
    const [i] = await sql`select reason, evidence_hash, expect_last_identify_at is not null as pinned from decider_batch_items where batch_id = ${batchId} limit 1`;
    expect(i).toEqual({ reason: 'model accept: jev-2026-09-15, probability 0.9950', evidence_hash: 'a'.repeat(64), pinned: true });
  });

  it('the same band twice adds nothing', async () => {
    const r = await call(owner, 'POST', `${runUrl()}/accept`, { band: 'p99' });
    expect(r.statusCode).toBe(202);
    expect(r.json()).toEqual({ batchId: null, albums: 0 });
    expect((await call(owner, 'GET', `${runUrl()}/accept-preview?band=p99`)).json()).toMatchObject({ albums: 0, alreadyAccepted: PICKS - 2 });
  });

  it('a backtest run is never accepted', async () => {
    expect((await call(owner, 'POST', `${runUrl(backtest)}/accept`, { band: 'p99' })).statusCode).toBe(409);
    expect((await call(owner, 'GET', `${runUrl(backtest)}/accept-preview?band=p99`)).statusCode).toBe(409);
  });

  it('the local decider is the default: a run needs a trained model, then nothing else', async () => {
    const lib0 = (await call(owner, 'GET', base())).json();
    expect(lib0.config.decider).toBe('local');
    expect(lib0.keySet).toBe(false);
    expect((await call(owner, 'GET', `${base()}/models`)).json()).toEqual({ active: null, models: [] });
    const refused = await call(owner, 'POST', `${base()}/runs`, { population: 'needs_review' });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().detail).toBe('No trained model');
    await storeModel(sql, {
      libraryId: lib, decider: 'local', version: 'local@0123456789ab', featuresSchemaHash: 'f'.repeat(64), model: {},
      dataHash: 'd'.repeat(64), counts: { albums: 300, rows: 900, owner: 250, auto: 50, rejections: 2 }, metrics: { albums: 50 },
    });
    const models = (await call(editor, 'GET', `${base()}/models`)).json();
    expect(models.active).toMatchObject({ version: 'local@0123456789ab', active: true, counts: { owner: 250 } });
    expect(models.models).toHaveLength(1);
    send.mockClear();
    const started = await call(owner, 'POST', `${base()}/runs`, { population: 'needs_review' });
    expect(started.statusCode).toBe(202);
    expect(started.json()).toMatchObject({ deciderId: 'local', modelLabel: 'Local', state: 'queued' });
    const [row] = await sql`select decider_id, model_requested from decider_runs where id = ${started.json().id}`;
    expect(row).toEqual({ decider_id: 'local', model_requested: 'local@0123456789ab' });
    expect(send).toHaveBeenCalledWith('decider.run', { runId: started.json().id }, expect.anything());
    await sql`update decider_runs set state = 'cancelled' where id = ${started.json().id}`;
  });

  it('Jev is chosen only with a key', async () => {
    const r = await call(owner, 'PATCH', `${base()}/config`, { decider: 'jev' });
    expect(r.statusCode).toBe(409);
    expect(r.json().detail).toBe('No TypeSafe key');
    expect((await call(owner, 'PATCH', `${base()}/config`, { decider: 'nobody' })).statusCode).toBe(400);
  });

  it('training is queued for the owner, once per library', async () => {
    expect((await call(editor, 'POST', `${base()}/train`, {})).statusCode).toBe(403);
    send.mockClear();
    const r = await call(owner, 'POST', `${base()}/train`, {});
    expect(r.statusCode).toBe(202);
    expect(r.json()).toEqual({ queued: true });
    expect(send).toHaveBeenCalledWith('decider.train', { libraryId: lib }, { singletonKey: `decider.train:${lib}` });
  });

  it('module off: no accept, no training', async () => {
    await setAutotaggerEnabled(sql, false);
    try {
      expect((await call(owner, 'POST', `${runUrl()}/accept`, { band: 'p99' })).statusCode).toBe(409);
      expect((await call(owner, 'POST', `${base()}/train`, {})).statusCode).toBe(409);
    } finally {
      await setAutotaggerEnabled(sql, true);
    }
  });
});
