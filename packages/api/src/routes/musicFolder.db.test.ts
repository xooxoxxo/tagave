/**
 * The music folder state, one answer for the owner's notice and the
 * updater's self-heal (db › musicFolder.ts): which roots are unreachable,
 * whether the LIB-5 guard stopped their scan, the updater's signed reports
 * (an audit entry each, a rescan once it mounted), and what the notice says.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import type { FastifyInstance } from 'fastify';
import type { AuthHandle } from '@tagave/auth';
import { signRequest } from '@tagave/updater/token';
import type { MusicFolderResponse } from '@tagave/shared';

const sent: Array<{ name: string; data: unknown }> = [];
vi.mock('../boss.js', () => ({
  getBoss: async () => ({
    send: async (name: string, data: unknown) => { sent.push({ name, data }); return 'job'; },
    createQueue: async () => undefined,
  }),
}));

const { TEST_APP_SECRET, TEST_PUBLIC_URL, buildAuthApp, cookieHeader, cookieJar, createScratchDb, migrateAll, testAuth } = await import('../testkit/authApp.js');
const { initDb } = await import('../db.js');
const { createMusicFolderInternalRoutes, createMusicFolderRoutes } = await import('./musicFolder.js');
const { healTargets, musicFolderNotice, musicFolderState, musicLooksUnmounted, waitingCounts } = await import('@tagave/db');
const { createTestUser } = await import('../testkit/users.js');

const url = process.env.TEST_DATABASE_URL;
const EMAIL = 'owner@example.com';
const PASSWORD = 'correct horse battery';

describe.skipIf(!url)('music folder state (integration)', () => {
  let admin: postgres.Sql;
  let db: { url: string; name: string };
  let handle: AuthHandle;
  let app: FastifyInstance;
  let jar: Record<string, string>;
  let libraryId: string;
  let rootA: string;
  let rootB: string;

  const signedGet = (path: string) => app.inject({ method: 'GET', url: path, headers: signRequest(TEST_APP_SECRET, 'GET', path) });
  const signedPost = (path: string, body: unknown) => {
    const text = JSON.stringify(body);
    return app.inject({ method: 'POST', url: path, headers: { ...signRequest(TEST_APP_SECRET, 'POST', path, text), 'content-type': 'application/json' }, payload: text });
  };
  /** A scan of the root, aborted (unmounted or not) or completed, `ago` seconds back. */
  const scan = async (rootId: string, status: 'aborted' | 'completed', unmounted: boolean, ago = 0) => {
    await handle.sql`insert into scans (scan_root_id, status, started_at, finished_at, stats)
      values (${rootId}, ${status}, now() - make_interval(secs => ${ago + 1}), now() - make_interval(secs => ${ago}), ${JSON.stringify(unmounted ? { mode: 'full', error: 'x', unmounted: true } : { mode: 'full' })}::text::jsonb)`;
    await handle.sql`update scan_roots set last_status = ${status}, last_scan_at = now() - make_interval(secs => ${ago}) where id = ${rootId}`;
  };

  beforeAll(async () => {
    process.env.ALLOW_INSECURE_HTTP = 'true';
    process.env.APP_SECRET = TEST_APP_SECRET;
    process.env.TAGAVE_UPDATER_URL = 'http://updater:8080';
    admin = postgres(url!, { max: 1, onnotice: () => undefined });
    db = await createScratchDb(url!, admin);
    await migrateAll(db.url);
    await initDb(db.url);
    handle = testAuth(db.url);
    app = await buildAuthApp(handle, async (instance) => {
      await instance.register(createMusicFolderRoutes, { prefix: '/api/v1' });
    }, async (root) => {
      await root.register(createMusicFolderInternalRoutes, { prefix: '/api/v1' });
    });
    const setup = await app.inject({ method: 'POST', url: '/api/v1/auth/setup', headers: { origin: TEST_PUBLIC_URL }, payload: { email: EMAIL, password: PASSWORD, displayName: 'Owner', contactString: EMAIL } });
    expect(setup.statusCode).toBe(201);
    [{ id: libraryId }] = await handle.sql<Array<{ id: string }>>`select id from libraries limit 1` as unknown as [{ id: string }];
    [{ id: rootA }] = await handle.sql<Array<{ id: string }>>`insert into scan_roots (library_id, path, display_name) values (${libraryId}, '/mnt/music', 'Music') returning id` as unknown as [{ id: string }];
    [{ id: rootB }] = await handle.sql<Array<{ id: string }>>`insert into scan_roots (library_id, path, display_name) values (${libraryId}, '/mnt/more', 'More') returning id` as unknown as [{ id: string }];
  });

  beforeEach(async () => {
    sent.length = 0;
    await handle.sql`delete from audit_log where action like 'music.heal%'`;
    await handle.sql`delete from scans`;
    await handle.sql`delete from parked_jobs`;
    await handle.sql`update scan_roots set last_status = 'completed', last_scan_at = now() - interval '1 hour', enabled = true, reach = 'unknown', reach_since = null, reach_reason = null`;
    const res = await app.inject({ method: 'POST', url: '/api/auth/sign-in/email', headers: { origin: TEST_PUBLIC_URL, 'content-type': 'application/json' }, payload: { email: EMAIL, password: PASSWORD } });
    jar = cookieJar(res.headers['set-cookie']);
  });

  afterAll(async () => {
    delete process.env.TAGAVE_UPDATER_URL;
    await app?.close();
    await handle?.close();
    if (db) await admin.unsafe(`drop database if exists ${db.name} with (force)`).catch(() => undefined);
    await admin?.end({ timeout: 2 });
  });

  const notice = async () => (await app.inject({ method: 'GET', url: '/api/v1/system/music-folder', headers: { cookie: cookieHeader(jar) } })).json();
  const none = { scans: 0, tagWrites: 0, other: 0 };
  /** The notice for roots with no reading yet whose latest scan was aborted (the legacy rule). */
  const legacy = (...roots: Array<'A' | 'B'>): MusicFolderResponse => {
    const folders = roots.map((r) => (r === 'A'
      ? { id: rootA, name: 'Music', path: '/mnt/music', reach: 'unknown' as const, since: null, reason: null, waiting: none }
      : { id: rootB, name: 'More', path: '/mnt/more', reach: 'unknown' as const, since: null, reason: null, waiting: none }));
    return { kind: 'offline', paths: folders.map((f) => f.path), folders };
  };
  /** What the healer is told: every enabled root's reach, by path (/mnt/more before /mnt/music). */
  const healer = (unmounted: boolean, a: string = 'unknown', b: string = 'unknown') => ({ unmounted, reach: [{ id: rootB, reach: b }, { id: rootA, reach: a }] });

  it('nothing while every scan finishes', async () => {
    expect(await notice()).toEqual({ kind: 'none', folders: [] });
    expect((await signedGet('/api/v1/internal/updater/music')).json()).toEqual(healer(false));
  });

  it('a root stopped by the LIB-5 guard: the notice names it, the updater is told it looks unmounted', async () => {
    await scan(rootA, 'aborted', true);
    expect(await notice()).toEqual(legacy('A'));
    expect((await signedGet('/api/v1/internal/updater/music')).json()).toEqual(healer(true));
  });

  it('a root aborted for another reason (missing path): the notice, but no self-heal', async () => {
    await scan(rootB, 'aborted', false);
    expect(await notice()).toEqual(legacy('B'));
    expect((await signedGet('/api/v1/internal/updater/music')).json()).toEqual(healer(false));
  });

  it('a disabled root and a later completed scan clear it', async () => {
    await scan(rootA, 'aborted', true, 60);
    await scan(rootA, 'completed', false);
    expect(await notice()).toEqual({ kind: 'none', folders: [] });
    await scan(rootB, 'aborted', true);
    await handle.sql`update scan_roots set enabled = false where id = ${rootB}`;
    expect(await notice()).toEqual({ kind: 'none', folders: [] });
  });

  it('the updater’s reports: an audit entry each; reconnecting while it runs, and after it mounted until the rescan', async () => {
    await scan(rootA, 'aborted', true, 120);
    expect((await signedPost('/api/v1/internal/updater/music-heal', { phase: 'start' })).statusCode).toBe(200);
    expect(await notice()).toEqual({ kind: 'healing', folders: [] });
    expect((await signedPost('/api/v1/internal/updater/music-heal', { phase: 'done', ok: true, reason: 'mounted' })).statusCode).toBe(200);
    expect(await notice()).toEqual({ kind: 'healing', folders: [] });
    expect(sent).toEqual([{ name: 'scan.root', data: { scanRootId: rootA, mode: 'full' } }]);
    const audit = await handle.sql`select action, payload, library_id from audit_log where action like 'music.heal%' order by at`;
    expect(audit.map((a) => [a.action, a.payload, a.library_id])).toEqual([['music.heal.start', {}, null], ['music.heal', { ok: true, reason: 'mounted' }, null]]);
    // the rescan finds it: gone
    await scan(rootA, 'completed', false);
    expect(await notice()).toEqual({ kind: 'none', folders: [] });
  });

  it('a heal that worked rescans only the root it concerned; an offline root stays in the notice', async () => {
    await scan(rootA, 'aborted', true, 120);
    await handle.sql`update scan_roots set reach = 'unmounted', reach_since = '2026-11-24T14:02:00Z', reach_reason = 'not_mounted' where id = ${rootA}`;
    await handle.sql`update scan_roots set reach = 'offline', reach_since = '2026-11-24T14:02:00Z', reach_reason = 'server_silent' where id = ${rootB}`;
    expect((await signedPost('/api/v1/internal/updater/music-heal', { phase: 'done', ok: true, reason: 'mounted' })).statusCode).toBe(200);
    expect(sent).toEqual([{ name: 'scan.root', data: { scanRootId: rootA, mode: 'full' } }]);
    expect(await notice()).toEqual({ kind: 'healing', folders: [] });
    const folderB = { id: rootB, name: 'More', path: '/mnt/more', reach: 'offline', since: '2026-11-24T14:02:00.000Z', reason: 'server_silent', waiting: none };
    // A's rescan completes: no longer healing, and B (still offline) is named
    await scan(rootA, 'completed', false);
    expect(await notice()).toMatchObject({ kind: 'offline', folders: expect.arrayContaining([folderB]) });
    // the watch reads A online: only B is left
    await handle.sql`update scan_roots set reach = 'online', reach_since = now(), reach_reason = null where id = ${rootA}`;
    expect(await notice()).toEqual({ kind: 'offline', paths: ['/mnt/more'], folders: [folderB] });
  });

  it('a failed heal, or a rescan that aborts again: unreachable', async () => {
    await scan(rootA, 'aborted', true, 120);
    await signedPost('/api/v1/internal/updater/music-heal', { phase: 'done', ok: false, reason: 'not_in_fstab' });
    expect(await notice()).toEqual(legacy('A'));
    expect(sent).toEqual([]);
    await signedPost('/api/v1/internal/updater/music-heal', { phase: 'done', ok: true, reason: 'mounted' });
    await scan(rootA, 'aborted', true);
    expect(await notice()).toEqual(legacy('A'));
  });

  it('a start that never ended goes stale after 10 minutes', async () => {
    await scan(rootA, 'aborted', true, 3600);
    const state = await musicFolderState(handle.sql);
    expect(musicFolderNotice({ ...state, heal: { phase: 'start', ok: null, reason: null, at: new Date(Date.now() - 11 * 60_000) } })).toEqual(legacy('A'));
  });

  it('an offline root shows in the notice with its since time and waiting counts', async () => {
    const rootId = rootA;
    const sql = handle.sql;
    await sql`update scan_roots set reach = 'offline', reach_since = '2026-11-24T14:02:00Z', reach_reason = 'server_silent' where id = ${rootId}`;
    await sql`insert into parked_jobs (scan_root_id, queue, data, singleton_key, reason) values (${rootId}, 'scan.root', '{}', ${'scan:' + rootId}, 'offline')`;
    const res = await app.inject({ method: 'GET', url: '/api/v1/system/music-folder', headers: { cookie: cookieHeader(jar) } });
    expect(res.json()).toEqual({ kind: 'offline', paths: ['/mnt/music'], folders: [{ id: rootId, name: 'Music', path: '/mnt/music', reach: 'offline', since: '2026-11-24T14:02:00.000Z', reason: 'server_silent', waiting: { scans: 1, tagWrites: 0, other: 0 } }] });
  });

  it('an unmounted root shows too, and a root the watch reads online drops out though its last scan aborted', async () => {
    await handle.sql`update scan_roots set reach = 'unmounted', reach_since = '2026-11-24T14:02:00Z', reach_reason = 'empty' where id = ${rootB}`;
    await scan(rootA, 'aborted', false);
    await handle.sql`update scan_roots set reach = 'online', reach_since = now() where id = ${rootA}`;
    expect(await notice()).toEqual({ kind: 'offline', paths: ['/mnt/more'], folders: [{ id: rootB, name: 'More', path: '/mnt/more', reach: 'unmounted', since: '2026-11-24T14:02:00.000Z', reason: 'empty', waiting: none }] });
  });

  it('a legacy aborted root with no reading still shows', async () => {
    await scan(rootA, 'aborted', false);
    const [row] = await handle.sql`select reach from scan_roots where id = ${rootA}`;
    expect(row?.reach).toBe('unknown');
    expect(await notice()).toEqual(legacy('A'));
  });

  it('a listener gets 403', async () => {
    await handle.sql`update scan_roots set reach = 'offline', reach_since = now(), reach_reason = 'timeout' where id = ${rootA}`;
    const listener = await createTestUser(handle, { role: 'listener' });
    const res = await app.inject({ method: 'GET', url: '/api/v1/system/music-folder', headers: { cookie: listener.cookie } });
    expect(res.statusCode).toBe(403);
  });

  it('the healer sees unmounted from reach', async () => {
    await handle.sql`update scan_roots set enabled = false where id = ${rootB}`;
    await handle.sql`update scan_roots set reach = 'unmounted', reach_since = now(), reach_reason = 'not_mounted' where id = ${rootA}`;
    expect((await signedGet('/api/v1/internal/updater/music')).json()).toEqual({ unmounted: true, reach: [{ id: rootA, reach: 'unmounted' }] });
    // offline is the healer's server_silent case: it does nothing there, even after a LIB-5 abort
    await scan(rootA, 'aborted', true);
    await handle.sql`update scan_roots set reach = 'offline', reach_reason = 'server_silent' where id = ${rootA}`;
    expect((await signedGet('/api/v1/internal/updater/music')).json()).toEqual({ unmounted: false, reach: [{ id: rootA, reach: 'offline' }] });
  });

  it('a watched root whose path is missing (offline, io_error) asks no heal', async () => {
    await scan(rootA, 'aborted', false); // the scan found no root folder
    await handle.sql`update scan_roots set reach = 'offline', reach_since = '2026-11-24T14:02:00Z', reach_reason = 'io_error' where id = ${rootA}`;
    const state = await musicFolderState(handle.sql);
    expect(musicLooksUnmounted(state)).toBe(false);
    expect(healTargets(state)).toEqual([]);
    expect((await signedGet('/api/v1/internal/updater/music')).json()).toEqual(healer(false, 'offline'));
    expect(await notice()).toMatchObject({ kind: 'offline', paths: ['/mnt/music'] });
  });

  it('a root that lists but is missing its sampled files reads online and asks no heal', async () => {
    // the watch read it online; even a LIB-5 abort of its last scan does not make it look unmounted
    await scan(rootA, 'aborted', true);
    await handle.sql`update scan_roots set reach = 'online', reach_since = now(), reach_reason = null where id = ${rootA}`;
    const state = await musicFolderState(handle.sql);
    expect(musicLooksUnmounted(state)).toBe(false);
    expect(healTargets(state)).toEqual([]);
    expect((await signedGet('/api/v1/internal/updater/music')).json()).toEqual(healer(false, 'online'));
    expect(await notice()).toEqual({ kind: 'none', folders: [] });
  });

  it('a heal that worked while every unreachable root is offline: the notice says offline, not healing, and nothing rescans', async () => {
    await scan(rootA, 'aborted', true, 120);
    await handle.sql`update scan_roots set reach = 'offline', reach_since = '2026-11-24T14:02:00Z', reach_reason = 'server_silent'`;
    expect((await signedPost('/api/v1/internal/updater/music-heal', { phase: 'done', ok: true, reason: 'mounted' })).statusCode).toBe(200);
    expect(sent).toEqual([]);
    expect(await notice()).toMatchObject({ kind: 'offline', paths: ['/mnt/more', '/mnt/music'] });
  });

  it('counts what waits per root: scans, tag writes (maintenance tasks too) and the rest', async () => {
    const sql = handle.sql;
    const task = async (kind: string, scope: string, queue: string) => (await sql<Array<{ id: string }>>`
      insert into maintenance_tasks (library_id, kind, scope_key, queue, input, state, stage)
      values (${libraryId}, ${kind}, ${scope}, ${queue}, '{}', 'waiting', 'Waiting for the music folder') returning id`)[0]!.id;
    const embed = await task('embed-cover', 'album-1', 'files.embedCover');
    const apply = await task('split', 'plan:p1:apply', 'tags.apply');
    const split = await task('split', 'split-1:split', 'files.split');
    const park = (rootId: string, queue: string, data: object, key: string | null) =>
      sql`insert into parked_jobs (scan_root_id, queue, data, singleton_key, reason) values (${rootId}, ${queue}, ${JSON.stringify(data)}::text::jsonb, ${key}, 'offline')`;
    await park(rootA, 'scan.root', {}, `scan:${rootA}`);
    await park(rootA, 'scan.dir', { dir: 'a' }, null);
    await park(rootA, 'tags.apply', { planId: 'p2' }, 'tags.apply:p2');
    await park(rootA, 'tags.revert', { planId: 'p3' }, null);
    await park(rootA, 'files.embedCover', {}, null);
    await park(rootA, 'maintenance', { taskId: embed }, `maintenance:${embed}`);
    await park(rootA, 'maintenance', { taskId: apply }, `maintenance:${apply}`);
    await park(rootA, 'maintenance', { taskId: split }, `maintenance:${split}`);
    await park(rootA, 'fingerprint.album', {}, null);
    await park(rootB, 'scan.parse', {}, null);
    const counts = await waitingCounts(sql, [rootA, rootB, '00000000-0000-4000-8000-000000000000']);
    expect(counts.get(rootA)).toEqual({ scans: 2, tagWrites: 5, other: 2 });
    expect(counts.get(rootB)).toEqual({ scans: 0, tagWrites: 0, other: 1 });
    expect(counts.get('00000000-0000-4000-8000-000000000000')).toEqual(none);
    expect((await waitingCounts(sql, [])).size).toBe(0);
    await sql`delete from maintenance_tasks where id in (${embed}, ${apply}, ${split})`;
  });

  it('takes every known reason, a silent music share too', async () => {
    // the updater's HEAL_REASONS, as a literal list (the updater does not depend on @tagave/db)
    const reasons = ['mounted', 'no_systemd', 'not_in_fstab', 'mount_failed', 'still_empty', 'restart_failed', 'docker_failed', 'server_silent'];
    for (const reason of reasons) {
      expect((await signedPost('/api/v1/internal/updater/music-heal', { phase: 'done', ok: reason === 'mounted', reason })).statusCode).toBe(200);
    }
    const audit = await handle.sql`select payload from audit_log where action = 'music.heal' order by at`;
    expect(audit.map((a) => a.payload.reason)).toEqual(reasons);
    expect(audit.at(-1)?.payload).toEqual({ ok: false, reason: 'server_silent' });
  });

  it('refuses unsigned calls, unknown reasons and anyone but the owner', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/internal/updater/music' })).statusCode).toBe(401);
    expect((await signedPost('/api/v1/internal/updater/music-heal', { phase: 'done', ok: false, reason: 'the host said: boom' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/v1/system/music-folder' })).statusCode).toBe(401);
  });
});

describe.skipIf(!url)('0097 reach columns', () => {
  let admin: postgres.Sql;
  let db: { url: string; name: string };
  let sql: postgres.Sql;
  let rootId: string;
  let planId: string;

  beforeAll(async () => {
    admin = postgres(url!, { max: 1, onnotice: () => undefined });
    db = await createScratchDb(url!, admin);
    await migrateAll(db.url);
    sql = postgres(db.url, { max: 2, onnotice: () => undefined });
    const idOf = (rows: Array<{ id: string }>) => rows[0]!.id;
    const userId = idOf(await sql<Array<{ id: string }>>`insert into users (email, display_name, password_hash) values ('robin@example.com', 'Robin', 'x') returning id`);
    const libraryId = idOf(await sql<Array<{ id: string }>>`insert into libraries (owner_user_id, name, settings) values (${userId}, 'Robin', '{}') returning id`);
    rootId = idOf(await sql<Array<{ id: string }>>`insert into scan_roots (library_id, path, display_name) values (${libraryId}, '/mnt/music', 'Music') returning id`);
    planId = idOf(await sql<Array<{ id: string }>>`insert into tag_plans (library_id, name, scope, policy, status, created_by)
      values (${libraryId}, 'p', '{"type":"library"}', '{"preset":"canonical_ids_and_fill"}', 'applying', ${userId}) returning id`);
  });

  afterAll(async () => {
    await sql?.end({ timeout: 2 });
    if (db) await admin.unsafe(`drop database if exists ${db.name} with (force)`).catch(() => undefined);
    await admin?.end({ timeout: 2 });
  });

  it('a root starts unknown, and takes only the four reach values', async () => {
    const [r] = await sql`select reach, reach_since from scan_roots where id = ${rootId}`;
    expect(r).toEqual({ reach: 'unknown', reach_since: null });
    await expect(sql`update scan_roots set reach = 'gone' where id = ${rootId}`).rejects.toThrow(/scan_roots_reach_check/);
    await expect(sql`update scan_roots set reach_reason = '192.0.2.10 down' where id = ${rootId}`).rejects.toThrow(/scan_roots_reach_reason_check/);
  });
  it('a tag plan can be waiting', async () => {
    await sql`update tag_plans set status = 'waiting' where id = ${planId}`;
    expect((await sql`select status from tag_plans where id = ${planId}`)[0]?.status).toBe('waiting');
    await expect(sql`update tag_plans set status = 'gone' where id = ${planId}`).rejects.toThrow(/tag_plans_status_check/);
  });
  it('parked_jobs keeps one row per root, queue and singleton key, and goes with its root', async () => {
    await sql`insert into parked_jobs (scan_root_id, queue, data, singleton_key, reason) values (${rootId}, 'scan.root', '{}', ${'scan:' + rootId}, 'offline')`;
    await sql`insert into parked_jobs (scan_root_id, queue, data, singleton_key, reason) values (${rootId}, 'scan.root', '{}', ${'scan:' + rootId}, 'offline') on conflict do nothing`;
    expect((await sql`select count(*)::int as n from parked_jobs where scan_root_id = ${rootId}`)[0]?.n).toBe(1);
    await sql`delete from scan_roots where id = ${rootId}`;
    expect((await sql`select count(*)::int as n from parked_jobs`)[0]?.n).toBe(0);
  });
});
