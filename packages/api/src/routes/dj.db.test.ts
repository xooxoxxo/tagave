/**
 * DJ (the dj module) against the real server on a scratch database: the
 * engine's contract (DjTrackInfo, peaks), who may call the routes, the asks
 * for the next tracks, and the plug/unplug round trip (Module Composition
 * Principle rule 5).
 *
 *   off            off from the start: every /me/dj route answers 404, nothing queued
 *   on             the owner turns it on (the sweep starts); tracks without
 *                  analysis come back with nulls and are queued at the
 *                  player's priority, measured ones with their values, in
 *                  the order asked; a failed one is served as missing
 *   peaks          0–1, ~900 bins; [] until measured
 *   analyze        only the asked tracks that need it, ahead of the sweep
 *   delete data    exactly the module's rows go, the core is as before
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import postgres from 'postgres';
import { getTableColumns } from 'drizzle-orm';
import { DJ_TABLES, djTrackAnalysis, syncInstalledModules } from '@tagave/db';
import { ledgerEntries } from '@tagave/core/facets';
import type { AuthHandle } from '@tagave/auth';
import type { DjTrackInfo } from '@tagave/shared';

const sent: Array<{ name: string; data: unknown; opts: { singletonKey?: string; priority?: number } }> = [];
vi.mock('../boss.js', () => ({ getBoss: async () => ({ send: async (name: string, data: unknown, opts: { singletonKey?: string }) => { sent.push({ name, data, opts }); return 'job'; } }) }));

const { registerApiRoutes } = await import('../app.js');
const { initAuth } = await import('../middleware/auth.js');
const { TEST_PUBLIC_URL, createScratchDb, migrateAll, testAuth } = await import('../testkit/authApp.js');
const { createTestUser } = await import('../testkit/users.js');
const { initDb } = await import('../db.js');
type TestUser = Awaited<ReturnType<typeof createTestUser>>;

const adminUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!adminUrl)('dj: the engine’s contract, the asks, the module switch, plug in and out (integration)', () => {
  let admin: postgres.Sql;
  let db: { url: string; name: string };
  let handle: AuthHandle;
  let sql: postgres.Sql;
  let app: FastifyInstance;
  let owner: TestUser;
  let anna: TestUser;
  let libraryId: string;
  const albumId = randomUUID();
  const [measured, missing, failed, gone] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const peaks = Buffer.from(Array.from({ length: 900 }, (_, i) => (i * 7) % 256));

  const as = (u: TestUser) => ({ cookie: u.cookie, origin: TEST_PUBLIC_URL });
  const get = (u: TestUser | null, url: string) => app.inject({ method: 'GET', url, headers: u ? { cookie: u.cookie } : {} });
  const tracks = (u: TestUser | null, ids: string[]) => get(u, `/api/v1/me/dj/tracks?ids=${ids.join(',')}`);
  const analyze = (u: TestUser, localTrackIds: unknown) => app.inject({ method: 'POST', url: '/api/v1/me/dj/analyze', headers: as(u), payload: { localTrackIds } });
  const turn = (u: TestUser, enabled: boolean) => app.inject({ method: 'PUT', url: '/api/v1/settings/dj', headers: as(u), payload: { enabled } });
  const coreSnapshot = async () => ({
    tracks: await sql`select * from local_tracks order by id`,
    files: await sql`select * from files order by id`,
    albums: await sql`select id, title_guess from local_albums order by id`,
  });

  beforeAll(async () => {
    admin = postgres(adminUrl!, { max: 1, onnotice: () => undefined });
    db = await createScratchDb(adminUrl!, admin);
    await migrateAll(db.url);
    await initDb(db.url);
    handle = testAuth(db.url);
    initAuth(handle);
    sql = postgres(db.url, { max: 2, onnotice: () => undefined });
    await syncInstalledModules(sql, ledgerEntries());
    owner = await createTestUser(handle, { role: 'owner' });
    anna = await createTestUser(handle, { role: 'listener' });
    const [lib] = await sql<Array<{ id: string }>>`insert into libraries (owner_user_id, name) values (${owner.userId}, 'Music') returning id::text as id`;
    libraryId = lib!.id;
    await sql`insert into local_albums (id, library_id, cluster_key, title_guess, artist_guess, state) values (${albumId}, ${libraryId}, ${`ck-${albumId}`}, 'Mix', 'DJ', 'matched')`;
    const rootId = randomUUID();
    await sql`insert into scan_roots (id, library_id, path, display_name, validation_status) values (${rootId}, ${libraryId}, '/nowhere', 'dj', 'ok')`;
    for (const [i, t] of [measured, missing, failed, gone].entries()) {
      const fileId = randomUUID();
      await sql`insert into files (id, library_id, scan_root_id, rel_path, handler, size_bytes, mtime, status, duration_ms)
                values (${fileId}, ${libraryId}, ${rootId}, ${`DJ/${i}.flac`}, 'audio', 1000, 5, ${t === gone ? 'missing' : 'present'}, 241000)`;
      await sql`insert into local_tracks (id, local_album_id, audio_file_id, track_no, disc_no, title_guess, duration_ms)
                values (${t}, ${albumId}, ${fileId}, ${i + 1}, 1, ${`T${i}`}, ${i === 0 ? 240500 : null})`;
    }
    await sql`insert into dj_track_analysis (local_track_id, audio_hash, file_size_bytes, file_mtime, duration_ms, bpm, bpm_confidence, first_beat_ms, trim_start_ms, trim_end_ms, peaks)
              values (${measured}, ${'a'.repeat(64)}, 1000, 5, 240480, 124.5, 0.91, 312, 40, 239000, ${peaks})`;
    await sql`insert into dj_track_analysis (local_track_id, file_size_bytes, file_mtime, error) values (${failed}, 1000, 5, 'ffmpeg could not decode the audio')`;
    app = Fastify({ logger: false });
    await app.register(fastifyCookie);
    await registerApiRoutes(app, { backupService: { dir: '/nonexistent' } as never });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await handle?.close();
    await sql?.end({ timeout: 2 });
    if (db) await admin.unsafe(`drop database if exists ${db.name} with (force)`).catch(() => undefined);
    await admin?.end({ timeout: 2 });
  });

  it('the drizzle schema has every column 0086 made', async () => {
    expect([...DJ_TABLES]).toEqual(['dj_track_analysis']);
    const inDb = (await sql<Array<{ c: string }>>`select column_name as c from information_schema.columns where table_name = 'dj_track_analysis'`).map((r) => r.c).sort();
    expect(Object.values(getTableColumns(djTrackAnalysis)).map((c) => c.name).sort()).toEqual(inDb);
  });

  it('off from the start: every /me/dj route answers 404 and nothing is queued', async () => {
    const facets = (await get(anna, '/api/v1/facets')).json();
    expect(facets.modules.find((m: { id: string }) => m.id === 'dj')).toMatchObject({ enabled: false, builtIn: false });
    sent.length = 0;
    expect((await tracks(anna, [measured])).statusCode).toBe(404);
    expect((await get(anna, `/api/v1/me/dj/peaks/${measured}`)).statusCode).toBe(404);
    expect((await analyze(anna, [missing])).statusCode).toBe(404);
    expect(sent).toEqual([]);
  });

  it('only the owner switches it; on, the sweep starts', async () => {
    expect((await turn(anna, true)).statusCode).toBe(403);
    expect((await get(anna, '/api/v1/settings/dj')).statusCode).toBe(403);
    sent.length = 0;
    const res = await turn(owner, true);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ enabled: true, analyzed: 1, tracks: 4, settings: {} });
    expect(sent).toEqual([{ name: 'dj.analyze', data: { sweep: true }, opts: expect.objectContaining({ singletonKey: 'dj:sweep', priority: 0 }) }]);
  });

  it('tracks: the contract, in the order asked; nulls where analysis is missing, which is queued at the player’s priority', async () => {
    sent.length = 0;
    const res = await tracks(anna, [missing, measured, randomUUID(), failed, gone]);
    expect(res.statusCode).toBe(200);
    const body = res.json() as DjTrackInfo[];
    const none = { bpm: null, bpmConfidence: null, firstBeatMs: null, trimStartMs: null, trimEndMs: null };
    expect(body).toEqual([
      { localTrackId: missing, ...none, durationMs: 241000, albumKey: albumId, trackNo: 2, discNo: 1 },
      { localTrackId: measured, bpm: 124.5, bpmConfidence: expect.closeTo(0.91, 5), firstBeatMs: 312, trimStartMs: 40, trimEndMs: 239000, durationMs: 240500, albumKey: albumId, trackNo: 1, discNo: 1 },
      // a failure is served as missing; it is not asked for again within the week
      { localTrackId: failed, ...none, durationMs: 241000, albumKey: albumId, trackNo: 3, discNo: 1 },
      // a file that is gone: its facts, nothing queued
      { localTrackId: gone, ...none, durationMs: 241000, albumKey: albumId, trackNo: 4, discNo: 1 },
    ]);
    expect(Object.keys(body[0]!).sort()).toEqual(['albumKey', 'bpm', 'bpmConfidence', 'discNo', 'durationMs', 'firstBeatMs', 'localTrackId', 'trackNo', 'trimEndMs', 'trimStartMs']);
    expect(sent).toEqual([{ name: 'dj.analyze', data: { localTrackId: missing }, opts: expect.objectContaining({ singletonKey: `dj:now:${missing}`, priority: 10 }) }]);
    // a changed file keeps its analysis while dj.analyze checks it (a re-tag), and is queued
    await sql`update files set mtime = 6 where id = (select audio_file_id from local_tracks where id = ${measured})`;
    sent.length = 0;
    expect((await tracks(anna, [measured])).json()[0].bpm).toBe(124.5);
    expect(sent.map((s) => (s.data as { localTrackId: string }).localTrackId)).toEqual([measured]);
    await sql`update files set mtime = 5 where id = (select audio_file_id from local_tracks where id = ${measured})`;
  });

  it('tracks: ids are required, track ids, at most 50; signed out: 401', async () => {
    expect((await get(anna, '/api/v1/me/dj/tracks')).statusCode).toBe(400);
    expect((await tracks(anna, ['nope'])).statusCode).toBe(400);
    expect((await tracks(anna, Array.from({ length: 51 }, () => randomUUID()))).statusCode).toBe(400);
    expect((await tracks(anna, Array.from({ length: 50 }, () => randomUUID()))).json()).toEqual([]);
    expect((await tracks(null, [measured])).statusCode).toBe(401);
  });

  it('peaks: 0–1, 900 bins; [] until measured (and queued); unknown: 404', async () => {
    const res = (await get(anna, `/api/v1/me/dj/peaks/${measured}`)).json();
    expect(res.peaks).toHaveLength(900);
    expect(res.peaks[0]).toBe(0);
    expect(res.peaks[1]).toBeCloseTo(7 / 255, 3);
    expect(res.peaks.every((v: number) => v >= 0 && v <= 1)).toBe(true);
    sent.length = 0;
    expect((await get(anna, `/api/v1/me/dj/peaks/${missing}`)).json()).toEqual({ peaks: [] });
    expect(sent.map((s) => s.name)).toEqual(['dj.analyze']);
    expect((await get(anna, `/api/v1/me/dj/peaks/${randomUUID()}`)).statusCode).toBe(404);
    expect((await get(anna, '/api/v1/me/dj/peaks/nope')).statusCode).toBe(404);
  });

  it('analyze: the asked tracks that need it, in order, ahead of the sweep', async () => {
    sent.length = 0;
    const res = await analyze(anna, [failed, missing, measured, gone]);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ queued: 1 });
    expect(sent).toEqual([{ name: 'dj.analyze', data: { localTrackId: missing }, opts: expect.objectContaining({ priority: 10 }) }]);
    // a failure a week old is tried again
    await sql`update dj_track_analysis set analyzed_at = now() - interval '8 days' where local_track_id = ${failed}`;
    sent.length = 0;
    expect((await analyze(anna, [failed, missing])).json()).toEqual({ queued: 2 });
    expect(sent.map((s) => (s.data as { localTrackId: string }).localTrackId)).toEqual([failed, missing]);
    expect((await analyze(anna, [])).statusCode).toBe(400);
    expect((await analyze(anna, ['nope'])).statusCode).toBe(400);
  });

  it('off: 404 again, nothing queued, the rows stay', async () => {
    expect((await turn(owner, false)).json()).toMatchObject({ enabled: false, analyzed: 1 });
    sent.length = 0;
    expect((await tracks(anna, [missing])).statusCode).toBe(404);
    expect(sent).toEqual([]);
    expect((await sql`select count(*)::int as n from dj_track_analysis`)[0]!.n).toBe(2);
  });

  it('plugged out: "delete its data" removes exactly its rows, the core is as it was, and nothing in the core points at it', async () => {
    await turn(owner, true);
    const before = await coreSnapshot();
    const res = await app.inject({ method: 'POST', url: '/api/v1/settings/dj/remove-data', headers: as(owner) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ enabled: false, analyzed: 0, removed: { dj_track_analysis: 2 } });
    expect(await coreSnapshot()).toEqual(before);
    const fks = await sql<Array<{ from: string; to: string; rule: string }>>`
      select c.conrelid::regclass::text as from, c.confrelid::regclass::text as to, c.confdeltype as rule
        from pg_constraint c where c.contype = 'f' and (c.conrelid::regclass::text like 'dj\\_%' or c.confrelid::regclass::text like 'dj\\_%')`;
    expect(fks).toEqual([{ from: 'dj_track_analysis', to: 'local_tracks', rule: 'c' }]);
    // a deleted track takes its row
    await sql`insert into dj_track_analysis (local_track_id, audio_hash) values (${measured}, ${'b'.repeat(64)})`;
    await sql`delete from local_tracks where id = ${measured}`;
    expect((await sql`select count(*)::int as n from dj_track_analysis`)[0]!.n).toBe(0);
  });
});
