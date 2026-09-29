/**
 * POST /tag-plans/:planId/add-items and GET /tag-plans?acceptsAlbums=true,
 * driven through the real route with fastify.inject against the test
 * database. pg-boss never runs in tests: sends are recorded, and a stand-in
 * pgboss.job table (the columns the route reads) holds queued jobs, the same
 * way clusterRepairDiscs.db.test.ts does it.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { eq, inArray } from 'drizzle-orm';
import { audioFiles, libraries, localAlbums, localTracks, scanRoots, tagPlanItems, tagPlans, users } from '@liner/db';

const sent = vi.hoisted(() => [] as Array<{ name: string; data: any; opts: any }>);
vi.mock('../boss.js', () => ({
  getBoss: async () => ({
    send: async (name: string, data: unknown, opts: unknown) => { sent.push({ name, data, opts }); return 'job-id'; },
  }),
}));

describe.skipIf(!process.env.TEST_DATABASE_URL)('tag plan add-items (route)', () => {
  let app: FastifyInstance;
  let db: any;
  let client: any;
  const ownerId = randomUUID();
  const strangerId = randomUUID();
  const libraryId = randomUUID();
  const otherLibraryId = randomUUID();
  const rootId = randomUUID();
  const fileId = randomUUID();
  const [album1, album2, album3, foreignAlbum] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const planIds: string[] = [];

  const policy = { preset: 'canonical_ids_and_fill', id3Version: '2.4', multiValueSeparator: '; ' };

  async function makePlan(status: string, scope: unknown = { type: 'albumIds', albumIds: [album1] }): Promise<string> {
    const id = randomUUID();
    planIds.push(id);
    await db.insert(tagPlans).values({
      id, libraryId, name: `plan ${status}`, scope, policy, status,
      stats: status === 'previewed' ? { filesTouched: 1, fieldsModified: 2, lockedFieldsRespected: 0, filesSkipped: [] } : {},
      createdBy: ownerId,
    });
    return id;
  }

  const planRow = async (id: string) => (await db.select().from(tagPlans).where(eq(tagPlans.id, id)))[0];
  const itemsOf = async (id: string) => db.select().from(tagPlanItems).where(eq(tagPlanItems.tagPlanId, id));
  const previewSends = (id: string) => sent.filter((j) => j.name === 'tags.preview' && j.data.planId === id);

  const add = (planId: string, payload: unknown, as: string = ownerId) =>
    app.inject({
      method: 'POST',
      url: `/libraries/${libraryId}/tag-plans/${planId}/add-items`,
      headers: { 'x-test-user': as },
      payload: payload as any,
    });

  beforeAll(async () => {
    const url = process.env.TEST_DATABASE_URL!;
    const { initDb } = await import('../db.js');
    const made = await initDb(url);
    db = made.db;
    client = made.client;
    await client`do $$ begin
      if not exists (select 1 from pg_namespace where nspname = 'pgboss') then create schema pgboss; end if;
    end $$`;
    await client`create table if not exists pgboss.job (
      id uuid, name text, state text, priority int, singleton_key text, data jsonb)`;
    // the preview route orders queued jobs by created_on
    await client`alter table pgboss.job add column if not exists created_on timestamptz default now()`;

    await db.insert(users).values([
      { id: ownerId, email: `owner-${ownerId}@test.com`, passwordHash: 'x' },
      { id: strangerId, email: `stranger-${strangerId}@test.com`, passwordHash: 'x' },
    ]);
    await db.insert(libraries).values([
      { id: libraryId, name: 'Plans', ownerUserId: ownerId, settings: {} },
      { id: otherLibraryId, name: 'Other', ownerUserId: strangerId, settings: {} },
    ]);
    await db.insert(localAlbums).values([
      { id: album1, libraryId, clusterKey: `a1-${album1}`, dirPaths: ['A/1'], state: 'matched', titleGuess: 'Kind of Blue', artistGuess: 'Miles Davis' },
      { id: album2, libraryId, clusterKey: `a2-${album2}`, dirPaths: ['A/2'], state: 'matched' },
      { id: album3, libraryId, clusterKey: `a3-${album3}`, dirPaths: ['A/3'], state: 'matched' },
      { id: foreignAlbum, libraryId: otherLibraryId, clusterKey: `f-${foreignAlbum}`, dirPaths: ['F'], state: 'matched' },
    ]);
    await db.insert(scanRoots).values({ id: rootId, libraryId, path: '/tmp/plans-root', displayName: 'plans', writable: true, validationStatus: 'ok' });
    await db.insert(audioFiles).values({ id: fileId, libraryId, scanRootId: rootId, relPath: 'A/1/01.flac', sizeBytes: 1, mtime: 1, status: 'present' });

    const { errorHandler } = await import('../middleware/errorHandler.js');
    const { createTagPlansRoutes } = await import('./tagPlans.js');
    app = Fastify({ logger: false });
    await errorHandler(app);
    app.addHook('preHandler', async (request) => {
      const id = request.headers['x-test-user'];
      request.user = typeof id === 'string' ? ({ id, email: `${id}@test.com` } as any) : undefined;
    });
    await app.register(createTagPlansRoutes, { prefix: '/libraries/:libraryId' });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    if (planIds.length) {
      await client`delete from pgboss.job where data->>'planId' = any(${planIds})`;
      await db.delete(tagPlanItems).where(inArray(tagPlanItems.tagPlanId, planIds));
      await db.delete(tagPlans).where(inArray(tagPlans.id, planIds));
    }
    await db.delete(scanRoots).where(eq(scanRoots.id, rootId)); // cascades the audio file
    await db.delete(localAlbums).where(inArray(localAlbums.libraryId, [libraryId, otherLibraryId]));
    await db.delete(libraries).where(inArray(libraries.id, [libraryId, otherLibraryId]));
    await db.delete(users).where(inArray(users.id, [ownerId, strangerId]));
    await client?.end({ timeout: 5 });
  });

  let previewed: string;
  beforeEach(async () => {
    sent.length = 0;
    previewed = await makePlan('previewed');
    await db.insert(tagPlanItems).values({
      tagPlanId: previewed, audioFileId: fileId, before: { title: 'a' }, after: { title: 'b' },
      diff: [{ field: 'title', before: 'a', after: 'b', reason: 'policy:overwrite' }], status: 'pending',
    });
  });

  it('adds an album to a previewed plan: back to draft, old preview dropped, a new preview queued', async () => {
    const res = await add(previewed, { scope: { type: 'albumIds', albumIds: [album2] } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ planId: previewed, added: 1, albumCount: 2, status: 'draft', previewQueued: true });

    const plan = await planRow(previewed);
    expect(plan.status).toBe('draft');
    expect(plan.stats).toEqual({});
    expect(plan.scope).toEqual({ type: 'albumIds', albumIds: [album1, album2] });
    expect(await itemsOf(previewed)).toHaveLength(0);
    expect(previewSends(previewed)).toEqual([
      { name: 'tags.preview', data: { planId: previewed }, opts: { singletonKey: `tag_plan:${previewed}` } },
    ]);
  });

  it('adding albums already in the plan changes nothing', async () => {
    const res = await add(previewed, { scope: { type: 'albumIds', albumIds: [album1, album1] } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ added: 0, albumCount: 1, status: 'previewed', previewQueued: false });

    const plan = await planRow(previewed);
    expect(plan.status).toBe('previewed');
    expect((plan.stats as any).filesTouched).toBe(1);
    expect(await itemsOf(previewed)).toHaveLength(1);
    expect(previewSends(previewed)).toHaveLength(0);
  });

  it('a draft plan grows too; every add asks for a preview under the one singleton key', async () => {
    const draft = await makePlan('draft');
    expect((await add(draft, { scope: { type: 'albumIds', albumIds: [album2] } })).statusCode).toBe(200);
    expect((await add(draft, { scope: { type: 'albumIds', albumIds: [album3] } })).statusCode).toBe(200);
    expect((await planRow(draft)).scope).toEqual({ type: 'albumIds', albumIds: [album1, album2, album3] });
    // The queue is stately: sends under one key collapse into the one waiting
    // preview, which reads the final scope when it starts.
    expect(previewSends(draft).map((j) => j.opts.singletonKey)).toEqual([`tag_plan:${draft}`, `tag_plan:${draft}`]);
  });

  it('renames a plan the wizard named after its first album, keeps a typed name', async () => {
    const named = await makePlan('draft');
    await db.update(tagPlans).set({ name: 'Miles Davis — Kind of Blue tags' }).where(eq(tagPlans.id, named));
    const res = await add(named, { scope: { type: 'albumIds', albumIds: [album2] } });
    expect(res.json()).toMatchObject({ added: 1, name: 'Miles Davis — Kind of Blue + 1 more album tags' });
    expect((await planRow(named)).name).toBe('Miles Davis — Kind of Blue + 1 more album tags');

    const typed = await makePlan('draft');
    await db.update(tagPlans).set({ name: 'Jazz cleanup' }).where(eq(tagPlans.id, typed));
    await add(typed, { scope: { type: 'albumIds', albumIds: [album2] } });
    expect((await planRow(typed)).name).toBe('Jazz cleanup');
  });

  const preview = (planId: string) =>
    app.inject({ method: 'POST', url: `/libraries/${libraryId}/tag-plans/${planId}/preview`, headers: { 'x-test-user': ownerId } });

  it('re-previews a previewed plan: back to draft, old rows dropped, one preview queued', async () => {
    const res = await preview(previewed);
    expect(res.statusCode).toBe(202);
    const plan = await planRow(previewed);
    expect(plan.status).toBe('draft');
    expect(plan.stats).toEqual({});
    expect(await itemsOf(previewed)).toHaveLength(0);
    expect(previewSends(previewed)).toHaveLength(1);
  });

  it('refuses to re-preview while an apply is queued, and leaves the preview alone', async () => {
    await client`insert into pgboss.job (id, name, state, priority, singleton_key, data)
      values (${randomUUID()}, 'tags.apply', 'created', 0, null, ${JSON.stringify({ planId: previewed })}::jsonb)`;
    const res = await preview(previewed);
    expect(res.statusCode).toBe(409);
    expect((await planRow(previewed)).status).toBe('previewed');
    expect(await itemsOf(previewed)).toHaveLength(1);
    expect(previewSends(previewed)).toHaveLength(0);
  });

  it.each(['applied', 'applying', 'paused', 'partially_failed', 'cancelled', 'reverted'])('refuses to preview a plan that is %s', async (status) => {
    const closed = await makePlan(status);
    expect((await preview(closed)).statusCode).toBe(400);
    expect(previewSends(closed)).toHaveLength(0);
  });

  it.each(['applied', 'applying', 'paused', 'partially_failed', 'cancelled', 'reverted'])('refuses a plan that is %s', async (status) => {
    const closed = await makePlan(status);
    const res = await add(closed, { scope: { type: 'albumIds', albumIds: [album2] } });
    expect(res.statusCode).toBe(409);
    expect(res.json().detail).toBe('This plan has already been applied or is being applied. Start a new plan instead.');
    const plan = await planRow(closed);
    expect(plan.status).toBe(status);
    expect(plan.scope).toEqual({ type: 'albumIds', albumIds: [album1] });
  });

  it('refuses a previewed plan whose apply job is queued but has not started', async () => {
    await client`insert into pgboss.job (id, name, state, priority, singleton_key, data)
                 values (${randomUUID()}, 'tags.apply', 'created', 0, ${'tags.apply:' + previewed}, ${JSON.stringify({ planId: previewed })}::jsonb)`;
    const res = await add(previewed, { scope: { type: 'albumIds', albumIds: [album2] } });
    expect(res.statusCode).toBe(409);
    const plan = await planRow(previewed);
    expect(plan.status).toBe('previewed');
    expect(await itemsOf(previewed)).toHaveLength(1);
  });

  it('refuses a plan scoped to an artist or the whole library', async () => {
    const artistPlan = await makePlan('draft', { type: 'artist', artistId: randomUUID() });
    const libraryPlan = await makePlan('previewed', { type: 'library' });
    for (const id of [artistPlan, libraryPlan]) {
      const res = await add(id, { scope: { type: 'albumIds', albumIds: [album2] } });
      expect(res.statusCode).toBe(409);
    }
    expect((await planRow(libraryPlan)).status).toBe('previewed');
  });

  it('refuses albums from another library', async () => {
    const res = await add(previewed, { scope: { type: 'albumIds', albumIds: [album2, foreignAlbum] } });
    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toBe('Some of these albums are not in this library.');
    expect((await planRow(previewed)).scope).toEqual({ type: 'albumIds', albumIds: [album1] });
  });

  it.each([
    ['no body', undefined],
    ['no scope', {}],
    ['a non-album scope', { scope: { type: 'library' } }],
    ['albumIds as a string', { scope: { type: 'albumIds', albumIds: album2 } }],
    ['an empty list', { scope: { type: 'albumIds', albumIds: [] } }],
    ['ids that are not uuids', { scope: { type: 'albumIds', albumIds: ['nope'] } }],
  ])('rejects %s with 400', async (_label, payload) => {
    const res = await add(previewed, payload);
    expect(res.statusCode).toBe(400);
    expect((await planRow(previewed)).status).toBe('previewed');
  });

  it('404s for a library the user does not own, and for an unknown plan', async () => {
    expect((await add(previewed, { scope: { type: 'albumIds', albumIds: [album2] } }, strangerId)).statusCode).toBe(404);
    expect((await add(randomUUID(), { scope: { type: 'albumIds', albumIds: [album2] } })).statusCode).toBe(404);
    expect((await planRow(previewed)).status).toBe('previewed');
  });

  it('401s without a session', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/libraries/${libraryId}/tag-plans/${previewed}/add-items`,
      payload: { scope: { type: 'albumIds', albumIds: [album2] } },
    });
    expect(res.statusCode).toBe(401);
  });

  it('lists only plans albums can be added to with ?acceptsAlbums=true', async () => {
    const applied = await makePlan('applied');
    const artistPlan = await makePlan('draft', { type: 'artist', artistId: randomUUID() });
    const draft = await makePlan('draft');
    const res = await app.inject({
      method: 'GET',
      url: `/libraries/${libraryId}/tag-plans?acceptsAlbums=true&limit=200`,
      headers: { 'x-test-user': ownerId },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const ids = body.items.map((p: { id: string }) => p.id);
    expect(ids).toContain(previewed);
    expect(ids).toContain(draft);
    expect(ids).not.toContain(applied);
    expect(ids).not.toContain(artistPlan);
    expect(body.items.every((p: { status: string; scope: { type: string } }) => ['draft', 'previewed'].includes(p.status) && p.scope.type === 'albumIds')).toBe(true);
    expect(body.total).toBe(body.items.length);
  });

  // ── rename ────────────────────────────────────────────────────────────
  const rename = (planId: string, payload: unknown, as: string = ownerId) =>
    app.inject({
      method: 'PATCH',
      url: `/libraries/${libraryId}/tag-plans/${planId}`,
      headers: { 'x-test-user': as },
      payload: payload as any,
    });

  it('renames a plan in any status, trimmed, and marks the name as the owner\'s', async () => {
    for (const status of ['draft', 'applied']) {
      const id = await makePlan(status);
      const res = await rename(id, { name: '  Peter   Morén  tidy-up ' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ id, name: 'Peter Morén tidy-up', nameByUser: true });
      const row = await planRow(id);
      expect(row.name).toBe('Peter Morén tidy-up');
      expect(row.nameByUser).toBe(true);
    }
  });

  it('refuses a blank or overlong name, a wrong body, and a plan of another library', async () => {
    const id = await makePlan('draft');
    const blank = await rename(id, { name: '   ' });
    expect(blank.statusCode).toBe(400);
    expect(blank.json().detail).toBe('The name cannot be empty');
    const long = await rename(id, { name: 'x'.repeat(256) });
    expect(long.statusCode).toBe(400);
    expect(long.json().detail).toMatch(/at most 255/);
    expect((await rename(id, { title: 'nope' })).statusCode).toBe(400);
    expect((await rename(id, { name: 'Mine' }, strangerId)).statusCode).toBe(404);
    expect((await rename(randomUUID(), { name: 'Ghost' })).statusCode).toBe(404);
    expect((await planRow(id)).name).toBe('plan draft');
  });

  it('never auto-renames a name the owner set, even one that looks like the wizard\'s', async () => {
    const id = await makePlan('draft');
    expect((await rename(id, { name: 'Miles Davis — Kind of Blue tags' })).statusCode).toBe(200);
    const res = await add(id, { scope: { type: 'albumIds', albumIds: [album2] } });
    expect(res.json()).toMatchObject({ added: 1, name: 'Miles Davis — Kind of Blue tags' });
    expect((await planRow(id)).name).toBe('Miles Davis — Kind of Blue tags');
  });

  // ── delete ────────────────────────────────────────────────────────────
  const del = (planId: string) =>
    app.inject({ method: 'DELETE', url: `/libraries/${libraryId}/tag-plans/${planId}`, headers: { 'x-test-user': ownerId } });
  const writeItem = async (planId: string, status: string) =>
    db.insert(tagPlanItems).values({
      tagPlanId: planId, audioFileId: fileId, before: { title: 'a' }, after: { title: 'b' },
      diff: [{ field: 'title', before: 'a', after: 'b', reason: 'policy:overwrite' }], status,
      ...(status === 'applied' ? { audioHashBefore: 'h', audioHashAfter: 'h' } : {}),
    });

  it('deletes a plan that wrote nothing with an empty 204', async () => {
    const res = await del(previewed);
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    expect(await planRow(previewed)).toBeUndefined();
  });

  it.each(['applied', 'partially_failed', 'cancelled'])('keeps a %s plan that wrote files: its journal is what Revert uses', async (status) => {
    const id = await makePlan(status);
    await writeItem(id, 'applied');
    const res = await del(id);
    expect(res.statusCode).toBe(409);
    expect(res.json().detail).toMatch(/wrote tags to 1 file.*Revert it first/);
    expect(await planRow(id)).toBeDefined();
    expect(await itemsOf(id)).toHaveLength(1);
  });

  it('deletes a plan once it has been reverted, and one whose every write failed', async () => {
    const reverted = await makePlan('reverted');
    await writeItem(reverted, 'applied');
    expect((await del(reverted)).statusCode).toBe(204);
    const failed = await makePlan('partially_failed');
    await writeItem(failed, 'failed');
    expect((await del(failed)).statusCode).toBe(204);
  });

  it('refuses to delete a plan that is writing', async () => {
    const id = await makePlan('applying');
    const res = await del(id);
    expect(res.statusCode).toBe(409);
    expect(res.json().detail).toMatch(/writing tags right now/);
  });

  // ── results ───────────────────────────────────────────────────────────
  it('reports the albums that hold the written files, and updating while a re-cluster is queued', async () => {
    const id = await makePlan('applied');
    await writeItem(id, 'applied');
    await db.insert(localTracks).values({ localAlbumId: album1, audioFileId: fileId, trackNo: 1 });
    const get = () => app.inject({ method: 'GET', url: `/libraries/${libraryId}/tag-plans/${id}/results`, headers: { 'x-test-user': ownerId } });

    const jobId = randomUUID();
    await client`insert into pgboss.job (id, name, state, priority, singleton_key, data)
      values (${jobId}, 'cluster.dir', 'created', 0, null, ${JSON.stringify({ libraryId, scanRootId: rootId, dirPath: 'A/1' })}::jsonb)`;
    let res = await get();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      filesWritten: 1, filesFailed: 0, albumsInScope: 1, looseFiles: 0, updating: true,
      albums: [{ id: album1, title: 'Kind of Blue', artistCredit: 'Miles Davis', artistId: null, planFiles: 1, mergedFrom: 0 }],
    });

    await client`update pgboss.job set state = 'completed' where id = ${jobId}`;
    res = await get();
    expect(res.json().updating).toBe(false);
    await client`delete from pgboss.job where id = ${jobId}`;
    await db.delete(localTracks).where(eq(localTracks.audioFileId, fileId));

    // Once no album holds the file, it is counted as loose.
    res = await get();
    expect(res.json()).toMatchObject({ filesWritten: 1, albums: [], looseFiles: 1 });
  });

  it('results of a plan that wrote nothing are empty; another library\'s plan is not found', async () => {
    const res = await app.inject({ method: 'GET', url: `/libraries/${libraryId}/tag-plans/${previewed}/results`, headers: { 'x-test-user': ownerId } });
    expect(res.json()).toEqual({ filesWritten: 0, filesFailed: 0, albumsInScope: 1, albums: [], looseFiles: 0, updating: false });
    const stranger = await app.inject({ method: 'GET', url: `/libraries/${libraryId}/tag-plans/${previewed}/results`, headers: { 'x-test-user': strangerId } });
    expect(stranger.statusCode).toBe(404);
  });

  it('list rows of plans that wrote files carry their counts', async () => {
    const id = await makePlan('applied');
    await writeItem(id, 'applied');
    const res = await app.inject({ method: 'GET', url: `/libraries/${libraryId}/tag-plans?limit=200`, headers: { 'x-test-user': ownerId } });
    const row = res.json().items.find((p: { id: string }) => p.id === id);
    expect(row.progress).toEqual({ applied: 1, failed: 0 });
    const draftRow = res.json().items.find((p: { id: string }) => p.id === previewed);
    expect(draftRow.progress).toBeUndefined();
  });
});
