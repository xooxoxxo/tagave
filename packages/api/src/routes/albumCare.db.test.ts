/**
 * Library care follows the albums it reports on (rr85). The owner's case:
 * Air – Talkie Walkie, a 10-track release. Seven tracks sit in one folder,
 * the last three in another, and each folder became its own album, both
 * identified as Talkie Walkie. Library care listed both as incomplete and the
 * pair as a duplicate. "Treat as one album" joined them, and Library care
 * still said three songs were missing until the nightly check.
 *
 * Against the real server on a scratch database: the gaps are found by the
 * worker's real gaps.recompute, then every album-changing route must leave
 * Library care right at once and queue a check of the albums it touched.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import postgres from 'postgres';
import type { AuthHandle } from '@tagave/auth';

const sent: Array<{ name: string; data: any }> = [];
vi.mock('../boss.js', () => ({
  getBoss: async () => ({
    send: async (name: string, data: unknown) => { sent.push({ name, data }); return randomUUID(); },
    createQueue: async () => undefined,
    fetch: async () => [],
    cancel: async () => undefined,
  }),
}));

const { registerApiRoutes } = await import('../app.js');
const { initAuth } = await import('../middleware/auth.js');
const { TEST_PUBLIC_URL, createScratchDb, migrateAll, testAuth } = await import('../testkit/authApp.js');
const { createTestUser } = await import('../testkit/users.js');
const { initDb } = await import('../db.js');
const { makeDb } = await import('@tagave/db');
type TestUser = Awaited<ReturnType<typeof createTestUser>>;

const here = path.dirname(fileURLToPath(import.meta.url));
const workerJob = (name: string) => path.resolve(here, '../../../worker/src/jobs', name);
const silent = { info() {}, warn() {}, debug() {}, error() {}, trace() {}, fatal() {}, child() { return silent; } };

const adminUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!adminUrl)('Library care after an album changes (integration)', () => {
  let db: { url: string; name: string };
  let sql: postgres.Sql;
  let handle: AuthHandle;
  let app: FastifyInstance;
  let owner: TestUser;
  let worker: { ctx: any; end: () => Promise<void> };
  let gapsRecomputeJob: (ctx: any, data: { libraryId: string; albumIds?: string[] }) => Promise<void>;
  let libraryId = '';
  const rootId = randomUUID();
  const main = randomUUID();
  const bonus = randomUUID();
  let rgId = '';

  const call = (method: 'GET' | 'POST', url: string, payload?: object) =>
    app.inject({ method, url: `/api/v1${url}`, headers: { cookie: owner.cookie, origin: TEST_PUBLIC_URL }, ...(payload ? { payload } : {}) });

  const openGaps = async (kind: string, subjectId: string) => sql<Array<{ state: string }>>`
    select state from gaps where library_id = ${libraryId} and kind = ${kind} and subject_id = ${subjectId} and state in ('open', 'todo')`;

  beforeAll(async () => {
    const admin = postgres(adminUrl!, { max: 1, onnotice: () => undefined });
    db = await createScratchDb(adminUrl!, admin);
    await admin.end({ timeout: 2 });
    await migrateAll(db.url);
    await initDb(db.url);
    handle = testAuth(db.url);
    initAuth(handle);
    sql = postgres(db.url, { max: 2, onnotice: () => undefined });
    owner = await createTestUser(handle, { role: 'owner' });
    const made = await makeDb(db.url);
    worker = {
      ctx: { db: made.db, sql: made.client, boss: { send: async () => randomUUID() }, logger: silent },
      end: () => (made.client as unknown as { end: (o: object) => Promise<void> }).end({ timeout: 2 }),
    };
    ({ gapsRecomputeJob } = await import(/* @vite-ignore */ workerJob('gapsRecompute.ts')));

    const [lib] = await sql<Array<{ id: string }>>`insert into libraries (owner_user_id, name, settings) values (${owner.userId}, 'Music', '{}'::jsonb) returning id::text as id`;
    libraryId = lib!.id;
    await sql`insert into scan_roots (id, library_id, path, display_name, validation_status) values (${rootId}, ${libraryId}, '/mnt/music', 'Music', 'ok')`;
    const [rg] = await sql<Array<{ id: string }>>`insert into release_groups (mbid, title) values (${randomUUID()}, 'Talkie Walkie') returning id::text as id`;
    rgId = rg!.id;
    const [rel] = await sql<Array<{ id: string }>>`insert into releases (release_group_id, mbid, title, track_count) values (${rgId}, ${randomUUID()}, 'Talkie Walkie', 10) returning id::text as id`;
    for (let n = 1; n <= 10; n++) {
      await sql`insert into canonical_tracks (release_id, medium_no, position, title, length_ms) values (${rel!.id}, 1, ${n}, ${`Track ${n}`}, 240000)`;
    }
    const pieces = [[main, 'Air/Talkie Walkie', [1, 2, 3, 4, 5, 6, 7]], [bonus, 'Air/Talkie Walkie (rest)', [8, 9, 10]]] as const;
    for (const [id, dir, numbers] of pieces) {
      await sql`insert into local_albums (id, library_id, cluster_key, dir_paths, title_guess, artist_guess, state, track_count, release_id, release_group_id, identified_at)
                values (${id}, ${libraryId}, ${`ck-${id}`}, ${[dir]}, 'Talkie Walkie', 'Air', 'matched', ${numbers.length}, ${rel!.id}, ${rgId}, now())`;
      for (const n of numbers) {
        const tags = { common: { title: `Track ${n}`, artist: 'Air', albumartist: 'Air', album: 'Talkie Walkie', year: 2004, track: { no: n, of: 10 } } };
        const [f] = await sql<Array<{ id: string }>>`
          insert into files (library_id, scan_root_id, rel_path, container, lossless, duration_ms, size_bytes, status, handler, has_embedded_art, tags_raw)
          values (${libraryId}, ${rootId}, ${`${dir}/${String(n).padStart(2, '0')}.flac`}, 'FLAC', true, 240000, 1000, 'present', 'audio', true, ${sql.json(tags)})
          returning id::text as id`;
        await sql`insert into local_tracks (local_album_id, audio_file_id, disc_no, track_no, title_guess, origin) values (${id}, ${f!.id}, 1, ${n}, ${`Track ${n}`}, 'file')`;
      }
    }
    // What Library care showed before the merge: the nightly check's findings.
    await gapsRecomputeJob(worker.ctx, { libraryId });

    app = Fastify({ logger: false });
    await app.register(fastifyCookie);
    await registerApiRoutes(app, { backupService: { dir: '/nonexistent' } as never });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await handle?.close();
    await worker?.end();
    await sql?.end({ timeout: 2 });
    const admin = postgres(adminUrl!, { max: 1, onnotice: () => undefined });
    await admin.unsafe(`drop database if exists ${db.name} with (force)`).catch(() => undefined);
    await admin.end({ timeout: 2 });
  });

  it('starts where the owner was: both pieces incomplete, the pair a duplicate', async () => {
    expect(await openGaps('incomplete_album', main)).toHaveLength(1);
    expect(await openGaps('incomplete_album', bonus)).toHaveLength(1);
    expect(await openGaps('duplicate', rgId)).toHaveLength(1);
  });

  it('"Treat as one album": the joined album is complete and the other album\'s problems are gone', async () => {
    const r = await call('POST', `/libraries/${libraryId}/albums/merge`, { albumIds: [main, bonus], targetId: main });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ albumId: main, mergedAlbumIds: [bonus] });

    expect(await openGaps('incomplete_album', main)).toEqual([]);
    expect(await openGaps('incomplete_album', bonus)).toEqual([]);
    expect(await openGaps('duplicate', rgId)).toEqual([]);
    const gone = await sql`select kind from gaps where subject_id = ${bonus} and state in ('open', 'todo')`;
    expect(gone).toEqual([]);

    const counts = (await call('GET', `/libraries/${libraryId}/gaps/counts`)).json();
    expect(counts.counts['incomplete_album'] ?? 0).toBe(0);
    expect(counts.counts['duplicate'] ?? 0).toBe(0);

    // the slower checks (quality flags) for both albums are queued
    const care = sent.filter((s) => s.name === 'gaps.recompute');
    expect(care.at(-1)?.data).toMatchObject({ libraryId });
    expect([...care.at(-1)!.data.albumIds].sort()).toEqual([main, bonus].sort());
  });

  it('the worker\'s scoped check agrees and keeps the joined album complete', async () => {
    await gapsRecomputeJob(worker.ctx, { libraryId, albumIds: [main, bonus] });
    expect(await openGaps('incomplete_album', main)).toEqual([]);
    expect(await openGaps('duplicate', rgId)).toEqual([]);
  });

  it('Split back: both pieces come back and Library care reports them again', async () => {
    const r = await call('POST', `/libraries/${libraryId}/albums/${main}/unmerge`);
    expect(r.statusCode).toBe(200);
    expect(await openGaps('incomplete_album', main)).toHaveLength(1);
    expect(await openGaps('incomplete_album', bonus)).toHaveLength(1);
    expect(await openGaps('duplicate', rgId)).toHaveLength(1);
  });
});
