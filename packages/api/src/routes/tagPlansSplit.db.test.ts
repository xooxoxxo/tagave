/**
 * Tagging splits a whole album in one file first (0089) against the real
 * server on a scratch database: a plan made for a one-file album finds its
 * cut points at once (even with Attention's check never run), the owner can
 * turn it off, nobody but the owner splits, a split being found is taken
 * over; Apply waits for the cuts, asks for Low cuts to be checked, then sets
 * the split going with the tags; Revert of a plan that only split undoes it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import postgres from 'postgres';
import type { AuthHandle } from '@tagave/auth';

const sent: Array<{ name: string; data: unknown }> = [];
vi.mock('../boss.js', () => ({
  getBoss: async () => ({
    send: async (name: string, data: unknown) => { sent.push({ name, data }); return `job-${sent.length}`; },
    createQueue: async () => undefined,
  }),
}));

const { registerApiRoutes } = await import('../app.js');
const { initAuth } = await import('../middleware/auth.js');
const { TEST_PUBLIC_URL, createScratchDb, migrateAll, testAuth } = await import('../testkit/authApp.js');
const { createTestUser } = await import('../testkit/users.js');
const { initDb } = await import('../db.js');
type TestUser = Awaited<ReturnType<typeof createTestUser>>;

const adminUrl = process.env.TEST_DATABASE_URL;

const POLICY = { preset: 'canonical_ids_and_fill', id3Version: '2.4', multiValueSeparator: '; ' } as const;
const lowPlan = (low: boolean) => ({
  sampleRate: 44100, channels: 2, bitsPerSample: 16, totalSamples: 1000,
  tracks: [
    { n: 1, disc: 1, position: 1, title: 'One', startSample: 0, endSample: 500, fileName: '01 - One.flac', shiftMs: null, confidence: null },
    { n: 2, disc: 1, position: 2, title: 'Two', startSample: 500, endSample: 1000, fileName: '02 - Two.flac', shiftMs: 0, confidence: low ? 'low' : 'high' },
  ],
});

describe.skipIf(!adminUrl)('a tag plan splits a one-file album first (integration)', () => {
  let db: { url: string; name: string };
  let sql: postgres.Sql;
  let handle: AuthHandle;
  let app: FastifyInstance;
  let owner: TestUser;
  let editor: TestUser;
  let libraryId = '';
  const rootId = randomUUID();
  const oneFile = randomUUID();
  const twoFiles = randomUUID();
  let oneFileId = '';

  const call = (u: TestUser, method: 'GET' | 'POST', url: string, payload?: object) =>
    app.inject({ method, url: `/api/v1/libraries/${libraryId}${url}`, headers: { cookie: u.cookie, origin: TEST_PUBLIC_URL }, ...(payload ? { payload } : {}) });
  const create = (u: TestUser, albumIds: string[], policy: object = POLICY) =>
    call(u, 'POST', '/tag-plans', { name: 'Tags', scope: { type: 'albumIds', albumIds }, policy });
  const splitsOf = (planId: string) => sql<Array<{ id: string; state: string; albumId: string }>>`
    select id::text as id, state, local_album_id::text as "albumId" from album_splits where tag_plan_id = ${planId}`;

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
    editor = await createTestUser(handle, { role: 'editor' });
    const [lib] = await sql<Array<{ id: string }>>`insert into libraries (owner_user_id, name, settings) values (${owner.userId}, 'Music', '{"tagWritesEnabled": true}'::jsonb) returning id::text as id`;
    libraryId = lib!.id;
    await sql`insert into scan_roots (id, library_id, path, display_name, validation_status, writable, probe_writable)
              values (${rootId}, ${libraryId}, '/mnt/music', 'Music', 'ok', true, true)`;
    const [rg] = await sql<Array<{ id: string }>>`insert into release_groups (mbid, title) values (${randomUUID()}, 'Album') returning id::text as id`;
    const [rel] = await sql<Array<{ id: string }>>`insert into releases (release_group_id, mbid, title, track_count) values (${rg!.id}, ${randomUUID()}, 'Album', 2) returning id::text as id`;
    await sql`insert into canonical_tracks (release_id, medium_no, position, title, length_ms)
              values (${rel!.id}, 1, 1, 'One', 1200000), (${rel!.id}, 1, 2, 'Two', 1144000)`;
    for (const [id, names] of [[oneFile, ['whole.flac']], [twoFiles, ['01.flac', '02.flac']]] as const) {
      // matched after the scan: Attention's nightly check never saw it (no one_file_album gap)
      await sql`insert into local_albums (id, library_id, cluster_key, title_guess, artist_guess, state, track_count, release_id, release_group_id)
                values (${id}, ${libraryId}, ${`ck-${id}`}, 'Album', 'Artist', 'matched', ${names.length}, ${rel!.id}, ${rg!.id})`;
      for (const name of names) {
        const [f] = await sql<Array<{ id: string }>>`insert into files (library_id, scan_root_id, rel_path, container, lossless, duration_ms, size_bytes, status, handler)
                  values (${libraryId}, ${rootId}, ${`A/${id}/${name}`}, 'FLAC', true, ${names.length === 1 ? 2_344_000 : 1_172_000}, 1000, 'present', 'audio') returning id::text as id`;
        await sql`insert into local_tracks (local_album_id, audio_file_id, track_no, title_guess, origin) values (${id}, ${f!.id}, 1, ${name}, 'file')`;
        if (id === oneFile) oneFileId = f!.id;
      }
    }
    app = Fastify({ logger: false });
    await app.register(fastifyCookie);
    await registerApiRoutes(app, { backupService: { dir: '/nonexistent' } as never });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await handle?.close();
    await sql?.end({ timeout: 2 });
    const admin = postgres(adminUrl!, { max: 1, onnotice: () => undefined });
    await admin.unsafe(`drop database if exists ${db.name} with (force)`).catch(() => undefined);
    await admin.end({ timeout: 2 });
  });

  it('detects the one-file album when the plan is made and finds its cut points', async () => {
    sent.length = 0;
    const r = await create(owner, [oneFile, twoFiles]);
    expect(r.statusCode).toBe(201);
    const plan = r.json();
    const rows = await splitsOf(plan.id);
    expect(rows).toEqual([{ id: expect.any(String), state: 'analyzing', albumId: oneFile }]);
    expect(sent).toContainEqual({ name: 'files.split', data: { splitId: rows[0]!.id, action: 'analyze' } });
    expect(plan.splits).toEqual([expect.objectContaining({ splitId: rows[0]!.id, albumId: oneFile, state: 'analyzing', tracks: 2, low: 0, plan: null })]);
    // the source file is the one the split reads
    expect((await sql`select file_id::text as id from album_splits where id = ${rows[0]!.id}`)[0]!.id).toBe(oneFileId);
    // (a draft's GET reads the preview job from pg-boss, which this test has not got)
    await sql`update tag_plans set status = 'previewed' where id = ${plan.id}`;
    const got = await call(owner, 'GET', `/tag-plans/${plan.id}`);
    expect(got.statusCode, got.body).toBe(200);
    expect(got.json().splits).toHaveLength(1);
  });

  it('takes over the cut points being found instead of asking twice', async () => {
    sent.length = 0;
    const r = await create(owner, [oneFile]);
    const rows = await splitsOf(r.json().id);
    expect(rows).toHaveLength(1);
    expect(sent.filter((s) => s.name === 'files.split')).toEqual([]);
  });

  it('splits nothing when the owner turns it off, for typed values, or for an editor', async () => {
    for (const r of [
      await create(owner, [oneFile], { ...POLICY, split: false }),
      await create(editor, [oneFile]),
    ]) {
      expect(r.statusCode).toBe(201);
      expect(await splitsOf(r.json().id)).toEqual([]);
      expect(r.json().splits).toBeUndefined();
    }
  });

  it('Apply waits for the cuts, asks for Low cuts to be checked, then splits with the tags', async () => {
    const plan = (await create(owner, [oneFile])).json();
    const [split] = await splitsOf(plan.id);
    await sql`update tag_plans set status = 'previewed' where id = ${plan.id}`;
    const waiting = await call(owner, 'POST', `/tag-plans/${plan.id}/apply`);
    expect(waiting.statusCode).toBe(409);
    expect(waiting.json().detail).toBe('Still finding the cut points. Try again in a moment.');

    await sql`update album_splits set state = 'ready', plan = ${sql.json(lowPlan(true))} where id = ${split!.id}`;
    const unchecked = await call(owner, 'POST', `/tag-plans/${plan.id}/apply`);
    expect(unchecked.statusCode).toBe(409);
    expect(unchecked.json().detail).toBe('Check the Low cuts first.');
    expect((await call(owner, 'GET', `/tag-plans/${plan.id}`)).json().splits[0]).toMatchObject({ state: 'ready', low: 1, tracks: 2 });

    // an editor may apply plans, but not one that splits: a split is the owner's (as Split)
    const byEditor = await call(editor, 'POST', `/tag-plans/${plan.id}/apply`, { confirmSplits: [split!.id] });
    expect(byEditor.statusCode).toBe(403);
    expect((await splitsOf(plan.id))[0]!.state).toBe('ready');

    sent.length = 0;
    const ok = await call(owner, 'POST', `/tag-plans/${plan.id}/apply`, { confirmSplits: [split!.id] });
    expect(ok.statusCode).toBe(202);
    expect((await splitsOf(plan.id))[0]!.state).toBe('splitting');
    expect(sent).toEqual([{ name: 'tags.apply', data: { planId: plan.id } }]);
  });

  it('a High-cut split needs no check', async () => {
    await sql`update album_splits set state = 'failed' where state = 'splitting'`;
    const plan = (await create(owner, [oneFile])).json();
    const [split] = await splitsOf(plan.id);
    await sql`update album_splits set state = 'ready', plan = ${sql.json(lowPlan(false))} where id = ${split!.id}`;
    await sql`update tag_plans set status = 'previewed' where id = ${plan.id}`;
    expect((await call(editor, 'POST', `/tag-plans/${plan.id}/apply`)).statusCode).toBe(403);
    expect((await splitsOf(plan.id))[0]!.state).toBe('ready');
    expect((await call(owner, 'POST', `/tag-plans/${plan.id}/apply`)).statusCode).toBe(202);
    // done, the plan that only split can be reverted: undoing the split is the revert
    await sql`update album_splits set state = 'done', outputs = ${['A/x/01 - One.flac', 'A/x/02 - Two.flac']} where id = ${split!.id}`;
    await sql`update tag_plans set status = 'applied' where id = ${plan.id}`;
    // undoing the split is the owner's too
    sent.length = 0;
    expect((await call(editor, 'POST', `/tag-plans/${plan.id}/revert`)).statusCode).toBe(403);
    expect(sent).toEqual([]);
    const rev = await call(owner, 'POST', `/tag-plans/${plan.id}/revert`);
    expect(rev.statusCode).toBe(202);
    expect(rev.json().revertPlanId).toBeNull();
    expect(sent).toEqual([{ name: 'tags.revert', data: { planId: plan.id, revertPlanId: expect.any(String) } }]);
  });
});
