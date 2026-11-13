/**
 * The autotagger module's settings against the real server on a scratch
 * database (the switch is the install-wide module ledger, so it is never
 * flipped on the shared test database): the switch and its fresh step-up,
 * the per-library settings and the API key (stored sealed, shown only as
 * its hint, to the owner only, never returned), prices, the off gate, and
 * deleting its data (accept batches stay).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import postgres from 'postgres';
import { markPayloadSeen, syncInstalledModules } from '@tagave/db';
import { ledgerEntries } from '@tagave/core/facets';
import { openSecret } from '@tagave/core';
import type { AuthHandle } from '@tagave/auth';

const bossSend = vi.hoisted(() => vi.fn(async (..._args: unknown[]): Promise<string | null> => 'job'));
vi.mock('../boss.js', () => ({ getBoss: async () => ({ send: bossSend }) }));

const { registerApiRoutes } = await import('../app.js');
const { initAuth } = await import('../middleware/auth.js');
const { TEST_APP_SECRET, TEST_PUBLIC_URL, createScratchDb, migrateAll, testAuth } = await import('../testkit/authApp.js');
const { createTestUser } = await import('../testkit/users.js');
const { initDb } = await import('../db.js');
type TestUser = Awaited<ReturnType<typeof createTestUser>>;

const adminUrl = process.env.TEST_DATABASE_URL;
const PLAIN_KEY = `ts-live-${randomUUID().replace(/-/g, '')}cdef`;

describe.skipIf(!adminUrl)('autotagger settings routes (integration, scratch db)', () => {
  let db: { url: string; name: string };
  let sql: postgres.Sql;
  let handle: AuthHandle;
  let app: FastifyInstance;
  let owner: TestUser;
  let editor: TestUser;
  let lib = '';
  const bodies: string[] = [];
  const prevSecret = process.env.APP_SECRET;

  const call = async (u: TestUser, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: object) => {
    const r = await app.inject({ method, url: `/api/v1${url}`, headers: { cookie: u.cookie, origin: TEST_PUBLIC_URL }, ...(payload ? { payload } : {}) });
    bodies.push(r.body);
    return r;
  };
  const get = (url: string) => call(owner, 'GET', url);
  const put = (url: string, body: object) => call(owner, 'PUT', url, body);
  const patch = (url: string, body: object) => call(owner, 'PATCH', url, body);
  const post = (url: string, body: object) => call(owner, 'POST', url, body);
  /** The owner's sign-in, made older than the step-up window, for one call. */
  const stale = async <T>(fn: () => Promise<T>): Promise<T> => {
    await sql`update auth_sessions set created_at = now() - make_interval(mins => 6) where user_id = ${owner.userId}`;
    try {
      return await fn();
    } finally {
      await sql`update auth_sessions set created_at = now() where user_id = ${owner.userId}`;
    }
  };

  beforeAll(async () => {
    process.env.APP_SECRET = TEST_APP_SECRET;
    const admin = postgres(adminUrl!, { max: 1, onnotice: () => undefined });
    db = await createScratchDb(adminUrl!, admin);
    await admin.end({ timeout: 2 });
    await migrateAll(db.url);
    await initDb(db.url);
    handle = testAuth(db.url);
    initAuth(handle);
    sql = postgres(db.url, { max: 2, onnotice: () => undefined });
    // a boot makes the module's ledger row
    await syncInstalledModules(sql, ledgerEntries());
    owner = await createTestUser(handle, { role: 'owner' });
    editor = await createTestUser(handle, { role: 'editor' });
    const [l] = await sql<Array<{ id: string }>>`insert into libraries (owner_user_id, name, settings) values (${owner.userId}, 'Music', '{}'::jsonb) returning id::text as id`;
    lib = l!.id;
    app = Fastify({ logger: false });
    await app.register(fastifyCookie);
    await registerApiRoutes(app, { backupService: { dir: '/nonexistent' } as never });
    await app.ready();
  });

  afterAll(async () => {
    if (prevSecret === undefined) delete process.env.APP_SECRET;
    else process.env.APP_SECRET = prevSecret;
    await app?.close();
    await handle?.close();
    await sql?.end({ timeout: 2 });
    const admin = postgres(adminUrl!, { max: 1, onnotice: () => undefined });
    if (db) await admin.unsafe(`drop database if exists ${db.name} with (force)`).catch(() => undefined);
    await admin.end({ timeout: 2 });
  });

  it('is off by default and refuses every library write while off; the library view still reads', async () => {
    expect((await get('/settings/autotagger')).json()).toEqual({ enabled: false, runs: 0, decisions: 0, prices: [] });
    for (const r of [
      await patch(`/libraries/${lib}/autotagger/config`, { monthlyCap: 10 }),
      await put(`/libraries/${lib}/autotagger/key`, { key: PLAIN_KEY }),
    ]) {
      expect(r.statusCode).toBe(409);
      expect(r.json().detail).toBe('Autotagger is off');
    }
    const view = await get(`/libraries/${lib}/autotagger`);
    expect(view.statusCode).toBe(200);
    expect(view.json()).toMatchObject({ enabled: false, keySet: false, keyHint: null, spentThisMonth: 0, spentOther: [], currency: 'USD', config: { model: 'jev-latest' } });
    expect((await get(`/libraries/${randomUUID()}/autotagger`)).statusCode).toBe(404);
    expect((await get('/libraries/not-a-uuid/autotagger')).statusCode).toBe(404);
  });

  it('turning it on needs a fresh step-up', async () => {
    const refused = await stale(() => put('/settings/autotagger', { enabled: true }));
    expect(refused.statusCode).toBe(403);
    expect(refused.json().title).toBe('Step-up required');
    expect((await get('/settings/autotagger')).json().enabled).toBe(false);
    expect((await put('/settings/autotagger', { enabled: 'yes' })).statusCode).toBe(400);
    bossSend.mockClear();
    const on = await put('/settings/autotagger', { enabled: true });
    expect(on.statusCode).toBe(200);
    expect(on.json().enabled).toBe(true);
    // on starts the matching-evidence backfill its deciders read
    expect(bossSend).toHaveBeenCalledWith('evidence.backfill', {}, { singletonKey: 'evidence.backfill' });
    const [row] = await sql`select enabled from installed_modules where id = 'autotagger'`;
    expect(row!.enabled).toBe(true);
  });

  it('stores the key sealed, shows only its hint, and never returns it', async () => {
    expect((await stale(() => put(`/libraries/${lib}/autotagger/key`, { key: PLAIN_KEY }))).statusCode).toBe(403);
    for (const bad of [{ key: 'short' }, { key: `${PLAIN_KEY} x` }, { key: 42 }, {}, { key: PLAIN_KEY, extra: 1 }]) {
      const r = await put(`/libraries/${lib}/autotagger/key`, bad);
      expect(r.statusCode, JSON.stringify(bad)).toBe(400);
    }
    const r = await put(`/libraries/${lib}/autotagger/key`, { key: PLAIN_KEY });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ keySet: true, keyHint: 'cdef', enabled: true });
    const [row] = await sql<Array<{ sealed_key: string; key_hint: string }>>`select sealed_key, key_hint from decider_library_settings where library_id = ${lib}`;
    expect(row!.sealed_key.startsWith('enc:')).toBe(true);
    expect(row!.key_hint).toBe('cdef');
    expect(openSecret(row!.sealed_key, TEST_APP_SECRET)).toBe(PLAIN_KEY);
    // never in libraries.settings
    const [l] = await sql<Array<{ settings: unknown }>>`select settings from libraries where id = ${lib}`;
    expect(JSON.stringify(l!.settings)).not.toMatch(/key|enc:/i);
    expect((await get(`/libraries/${lib}/autotagger`)).json()).toMatchObject({ keySet: true, keyHint: 'cdef' });
  });

  it('validates the config and prices', async () => {
    const tooHigh = await patch(`/libraries/${lib}/autotagger/config`, { maxErrorRate: 0.5 });
    expect(tooHigh.statusCode).toBe(400);
    expect((await patch(`/libraries/${lib}/autotagger/config`, { payloadSeenAt: new Date().toISOString() })).statusCode).toBe(400);
    expect((await patch(`/libraries/${lib}/autotagger/config`, { monthlyCap: 25, currency: 'EUR' })).json().config).toMatchObject({ monthlyCap: 25, currency: 'EUR', maxErrorRate: 0.01 });
    expect((await get(`/libraries/${lib}/autotagger`)).json()).toMatchObject({ currency: 'EUR', config: { monthlyCap: 25 } });

    expect((await put('/settings/autotagger/prices', { model: '*', perMillionInput: 0.8, currency: 'EUR' })).json().prices).toEqual([{ model: '*', perMillionInput: 0.8, currency: 'EUR' }]);
    expect((await put('/settings/autotagger/prices', { model: 'jev-2026-09-15', perMillionInput: 0.5, currency: 'EUR' })).json().prices).toEqual([
      { model: '*', perMillionInput: 0.8, currency: 'EUR' },
      { model: 'jev-2026-09-15', perMillionInput: 0.5, currency: 'EUR' },
    ]);
    expect((await put('/settings/autotagger/prices', { model: '*', perMillionInput: 1.25, currency: 'EUR' })).json().prices[0]).toEqual({ model: '*', perMillionInput: 1.25, currency: 'EUR' });
    for (const bad of [{ model: 'Any', perMillionInput: 1, currency: 'EUR' }, { model: '*', perMillionInput: -1, currency: 'EUR' }, { model: '*', perMillionInput: 1, currency: 'eur' }]) {
      expect((await put('/settings/autotagger/prices', bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }
    const del = await call(owner, 'DELETE', '/settings/autotagger/prices/jev-2026-09-15');
    expect(del.statusCode).toBe(200);
    expect(del.json().prices).toEqual([{ model: '*', perMillionInput: 1.25, currency: 'EUR' }]);
    expect((await call(owner, 'DELETE', '/settings/autotagger/prices/jev-2026-09-15')).statusCode).toBe(404);
  });

  it('counts runs, decisions and this month’s spend', async () => {
    const albumId = randomUUID();
    await sql`insert into local_albums (id, library_id, cluster_key, title_guess, artist_guess, state) values (${albumId}, ${lib}, ${`ck-${albumId}`}, 'A', 'B', 'needs_review')`;
    const [run] = await sql<Array<{ id: string }>>`insert into decider_runs (library_id, decider_id, spec_hash, model_requested, population) values (${lib}, 'jev', 's1', 'jev-latest', 'needs_review') returning id::text as id`;
    const call1 = (hash: string, cost: number, at: string, currency = 'EUR') => sql`
      insert into decider_calls (library_id, local_album_id, run_id, evidence_hash, spec_hash, decider_id, decider_version, request_bytes, input_tokens, cost, currency, answers, created_at)
      values (${lib}, ${albumId}, ${run!.id}, ${hash.padEnd(64, '0')}, 's1', 'jev', 'jev-2026-09-15', 100, 1000, ${cost}, ${currency}, '{}'::jsonb, ${at}::timestamptz)`;
    await call1('a', 0.25, new Date().toISOString());
    await call1('b', 0.5, new Date().toISOString());
    await call1('c', 9, '2020-01-15T00:00:00Z');
    // a call from before the currency was changed: apart, never added in
    await call1('d', 0.1, new Date().toISOString(), 'USD');
    await sql`insert into decider_decisions (run_id, local_album_id, outcome) values (${run!.id}, ${albumId}, 'none')`;
    expect((await get('/settings/autotagger')).json()).toMatchObject({ enabled: true, runs: 1, decisions: 1 });
    const v = (await get(`/libraries/${lib}/autotagger`)).json();
    expect(v.currency).toBe('EUR');
    expect(v.spentThisMonth).toBeCloseTo(0.75, 6);
    expect(v.spentOther).toEqual([{ currency: 'USD', amount: 0.1 }]);
  });

  it('an editor sees the library view without the key hint or who saw the payload, and cannot change anything', async () => {
    await markPayloadSeen(sql, lib, owner.userId);
    expect((await get(`/libraries/${lib}/autotagger`)).json().config.payloadSeenBy).toBe(owner.userId);
    const v = await call(editor, 'GET', `/libraries/${lib}/autotagger`);
    expect(v.statusCode).toBe(200);
    expect(v.json()).toMatchObject({ keySet: true, keyHint: null, enabled: true, config: { payloadSeenBy: null } });
    expect(v.json().config.payloadSeenAt).toEqual(expect.any(String));
    expect((await call(editor, 'PATCH', `/libraries/${lib}/autotagger/config`, { monthlyCap: 1 })).statusCode).toBe(403);
    expect((await call(editor, 'PUT', `/libraries/${lib}/autotagger/key`, { key: PLAIN_KEY })).statusCode).toBe(403);
    expect((await call(editor, 'GET', '/settings/autotagger')).statusCode).toBe(403);
    expect((await call(editor, 'PUT', '/settings/autotagger', { enabled: false })).statusCode).toBe(403);
    expect((await call(editor, 'POST', '/settings/autotagger/remove-data', {})).statusCode).toBe(403);
    expect((await call(editor, 'PUT', '/settings/autotagger/prices', { model: '*', perMillionInput: 0, currency: 'EUR' })).statusCode).toBe(403);
  });

  it('forgets the key with null', async () => {
    const r = await put(`/libraries/${lib}/autotagger/key`, { key: null });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ keySet: false, keyHint: null });
    const [row] = await sql`select sealed_key, key_hint from decider_library_settings where library_id = ${lib}`;
    expect(row).toMatchObject({ sealed_key: null, key_hint: null });
    // the settings stay
    expect((await get(`/libraries/${lib}/autotagger`)).json().config).toMatchObject({ monthlyCap: 25, currency: 'EUR' });
    // set again for the next test
    await put(`/libraries/${lib}/autotagger/key`, { key: PLAIN_KEY });
  });

  it('audits setting and clearing the key with the library and who, never the key or its hint', async () => {
    const rows = await sql<Array<{ action: string; library_id: string; actor_user_id: string; subject_id: string; payload: unknown }>>`
      select action, library_id::text, actor_user_id::text, subject_id::text, payload from audit_log where action like 'autotagger.key_%' order by at`;
    expect(rows.map((r) => r.action)).toEqual(['autotagger.key_set', 'autotagger.key_cleared', 'autotagger.key_set']);
    for (const r of rows) {
      expect(r).toMatchObject({ library_id: lib, actor_user_id: owner.userId, subject_id: lib, payload: null });
      const text = JSON.stringify(r);
      expect(text).not.toContain(PLAIN_KEY.slice(0, 16));
      expect(text).not.toContain('cdef');
      expect(text).not.toContain('enc:');
    }
  });

  it('deleting its data needs a fresh step-up, turns it off, empties its tables and leaves accept batches', async () => {
    const [batch] = await sql<Array<{ id: string }>>`insert into decider_batches (library_id, decider_id, decided_kind) values (${lib}, 'jev', 'model') returning id::text as id`;
    expect((await stale(() => post('/settings/autotagger/remove-data', {}))).statusCode).toBe(403);
    expect((await get('/settings/autotagger')).json().enabled).toBe(true);

    const r = await post('/settings/autotagger/remove-data', {});
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ enabled: false, runs: 0, decisions: 0, prices: [] });
    expect(r.json().removed).toMatchObject({ decider_runs: 1, decider_calls: 4, decider_decisions: 1, decider_prices: 1, decider_library_settings: 1 });
    const [left] = await sql<Array<{ settings: number; batches: number }>>`
      select (select count(*)::int from decider_library_settings) as settings, (select count(*)::int from decider_batches where id = ${batch!.id}) as batches`;
    expect(left).toEqual({ settings: 0, batches: 1 });
    const [audit] = await sql<Array<{ payload: { module: string } }>>`select payload from audit_log where action = 'module.remove_data' order by at desc limit 1`;
    expect(audit!.payload.module).toBe('autotagger');
    // the switch is audited before the delete
    const trail = await sql<Array<{ action: string }>>`select action from audit_log where action in ('module.disable', 'module.remove_data') order by at`;
    expect(trail.map((t) => t.action)).toEqual(['module.disable', 'module.remove_data']);
    expect(JSON.stringify(audit!.payload)).not.toContain('enc:');
    expect((await get(`/libraries/${lib}/autotagger`)).json()).toMatchObject({ enabled: false, keySet: false, keyHint: null });
    // off again: the library writes refuse
    expect((await patch(`/libraries/${lib}/autotagger/config`, { monthlyCap: 1 })).statusCode).toBe(409);
  });

  it('a partly missing module schema is an error, not "nothing to delete": off, data kept, retry safe', async () => {
    await put('/settings/autotagger', { enabled: true });
    await put('/settings/autotagger/prices', { model: '*', perMillionInput: 1, currency: 'EUR' });
    // this scratch database only
    await sql`drop table decider_spot_checks`;
    const r = await post('/settings/autotagger/remove-data', {});
    expect(r.statusCode).toBe(500);
    expect(r.json()).toMatchObject({ title: 'Data not removed', enabled: false, removed: null });
    expect((await get('/settings/autotagger')).json()).toMatchObject({ enabled: false, prices: [{ model: '*' }] });
  });

  it('reads zero, and deletes nothing, when the module’s tables are not there (never migrated)', async () => {
    await sql`drop table decider_decisions, decider_calls, decider_runs, decider_prices, decider_library_settings, decider_models`;
    const removed = await post('/settings/autotagger/remove-data', {});
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toMatchObject({ enabled: false, removed: {} });
    const r = await get('/settings/autotagger');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ enabled: false, runs: 0, decisions: 0, prices: [] });
    const v = await get(`/libraries/${lib}/autotagger`);
    expect(v.statusCode).toBe(200);
    expect(v.json()).toMatchObject({ keySet: false, spentThisMonth: 0, config: { model: 'jev-latest' } });
  });

  it('never returned the key, plain or sealed, in any response', async () => {
    expect(bodies.length).toBeGreaterThan(20);
    for (const b of bodies) {
      expect(b).not.toContain(PLAIN_KEY);
      expect(b).not.toContain(PLAIN_KEY.slice(0, 16));
      expect(b).not.toContain('enc:');
    }
  });
});
