/**
 * Accept batch routes: the list (newest first, counts, who ran it, the
 * bridging still to come), one batch with what it skipped or left, the
 * undo (who may, which states, a send the queue already holds) and the
 * owner's pace for the nightly bridge.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { createBatch, getBatch, transitionBatch, libraries, releaseGroups, users, type BatchItemInput } from '@tagave/db';

// the queue: tests make a send come back empty (the stately policy holds a job already)
const boss = vi.hoisted(() => ({ send: null as any, cancel: null as any }));
vi.mock('../boss.js', () => ({ getBoss: async () => ({ send: boss.send, cancel: boss.cancel }) }));

describe.skipIf(!process.env.TEST_DATABASE_URL)('accept batch routes', () => {
  let app: FastifyInstance;
  let db: any;
  let client: any;
  const owner = randomUUID();
  const editor = randomUUID();
  const lib = randomUUID();
  const otherLib = randomUUID();
  const rgId = randomUUID();
  const madeReleases: string[] = [];
  const madeJobs: string[] = [];
  let ruleBatch: string;
  let modelBatch: string;
  let skippedAlbum: string;
  let leftAlbum: string;
  const roles: Record<string, string> = {};

  const req = (method: 'GET' | 'PUT' | 'POST', url: string, body?: unknown, as: string = owner) =>
    app.inject({ method, url, headers: { 'x-test-user': as }, ...(body !== undefined ? { payload: body as object } : {}) });
  const get = async (url: string) => (await req('GET', url)).json();
  const post = (url: string, body: unknown) => req('POST', url, body);
  const postAs = (as: string, url: string, body: unknown) => req('POST', url, body, as);
  const put = (url: string, body: unknown) => req('PUT', url, body);

  /** an album in the library, matched to a fresh release that has an MBID and no Discogs id yet */
  async function album(state = 'matched'): Promise<{ id: string; releaseId: string }> {
    const id = randomUUID();
    const releaseId = randomUUID();
    madeReleases.push(releaseId);
    await client`insert into releases (id, release_group_id, mbid, title, status, track_count, source_of_truth)
                 values (${releaseId}, ${rgId}, ${randomUUID()}, 'Batch Album', 'Official', 1, 'musicbrainz')`;
    await client`insert into local_albums (id, library_id, cluster_key, dir_paths, title_guess, artist_guess, state, release_id, track_count)
                 values (${id}, ${lib}, ${`b-${id}`}, ${[`b/${id}`]}, ${`Title ${id.slice(0, 4)}`}, 'Batch Artist', ${state},
                         ${state === 'matched' ? releaseId : null}, 1)`;
    return { id, releaseId };
  }
  const item = (a: { id: string; releaseId: string }, model = false): BatchItemInput => ({
    albumId: a.id, releaseId: a.releaseId, distance: 0.05, source: 'mb_search', probability: model ? 0.99 : null,
    evidenceHash: model ? 'e'.repeat(64) : null, expectLastIdentifyAt: model ? new Date().toISOString() : null, reason: 'test accept',
  });
  async function mark(batchId: string, albumId: string, status: string, reason: string | null = null) {
    await client`update decider_batch_items set status = ${status}, skip_reason = ${reason},
                        accepted_at = case when ${status}::text = 'accepted' then now() else accepted_at end
                  where batch_id = ${batchId} and local_album_id = ${albumId}`;
  }
  /** an accepted rule batch of one album */
  async function acceptedRuleBatch(): Promise<string> {
    const a = await album();
    const b = await createBatch(client, { libraryId: lib, deciderId: 'rules', deciderVersion: null, decidedKind: 'rule', startedByUserId: owner, items: [item(a)] });
    await mark(b, a.id, 'accepted');
    await transitionBatch(client, b, ['queued'], 'accepted');
    return b;
  }
  async function queuedJob(batchId: string, state: string, mode: 'accept' | 'undo') {
    const id = randomUUID();
    madeJobs.push(id);
    await client`insert into pgboss.job (id, name, state, priority, singleton_key, data)
                 values (${id}, 'decider.accept', ${state}, 0, ${`decider:${batchId}`}, ${JSON.stringify({ batchId, mode })}::jsonb)`;
    return id;
  }

  beforeAll(async () => {
    const { initDb } = await import('../db.js');
    const made = await initDb(process.env.TEST_DATABASE_URL!);
    db = made.db;
    client = made.client;
    await db.insert(users).values([
      { id: owner, email: `bo-${owner}@test.com`, passwordHash: 'x', displayName: 'Ada', role: 'owner' },
      { id: editor, email: `be-${editor}@test.com`, passwordHash: 'x', displayName: 'Ed', role: 'editor' },
    ]);
    roles[owner] = 'owner';
    roles[editor] = 'editor';
    await db.insert(libraries).values([
      { id: lib, name: 'Batches', ownerUserId: owner, settings: {} },
      { id: otherLib, name: 'Other', ownerUserId: owner, settings: {} },
    ]);
    await db.insert(releaseGroups).values({ id: rgId, mbid: randomUUID(), title: 'Batch Album', artistCredit: ['Batch Artist'] });

    // the rule batch first, then the model batch: two accepted, one skipped
    // (identified again), one whose album is gone, one left by a newer decision
    ruleBatch = await acceptedRuleBatch();
    const a1 = await album();
    const a2 = await album();
    const skipped = await album('needs_review');
    const left = await album();
    const gone = { id: randomUUID(), releaseId: a1.releaseId };
    skippedAlbum = skipped.id;
    leftAlbum = left.id;
    modelBatch = await createBatch(client, {
      libraryId: lib, deciderId: 'jev', deciderVersion: 'jev-2026-09-15', decidedKind: 'model', startedByUserId: owner, band: 'high',
      items: [item(a1, true), item(a2, true), item(skipped, true), item(gone, true), item(left, true)],
    });
    await mark(modelBatch, a1.id, 'accepted');
    await mark(modelBatch, a2.id, 'accepted');
    await mark(modelBatch, skipped.id, 'skipped', 'reidentified');
    await mark(modelBatch, gone.id, 'skipped', 'gone');
    await mark(modelBatch, left.id, 'left', 'newer_decision');
    await transitionBatch(client, modelBatch, ['queued'], 'accepted');

    const { errorHandler } = await import('../middleware/errorHandler.js');
    const { createBatchRoutes } = await import('./batches.js');
    app = Fastify({ logger: false });
    await errorHandler(app);
    app.addHook('preHandler', async (request) => {
      const id = request.headers['x-test-user'];
      request.user = typeof id === 'string' ? ({ id, email: `${id}@test.com`, role: roles[id] ?? 'listener' } as any) : undefined;
    });
    await app.register(createBatchRoutes, { prefix: '/api/v1' });
    await app.ready();
  });

  beforeEach(() => {
    boss.send = vi.fn(async () => 'job-id');
    boss.cancel = vi.fn(async () => ({ affected: 1 }));
  });

  afterAll(async () => {
    await app?.close();
    if (madeJobs.length) await client`delete from pgboss.job where id = any(${madeJobs}::uuid[])`;
    await db.delete(libraries).where(eq(libraries.id, lib)); // cascades albums and batches
    await db.delete(libraries).where(eq(libraries.id, otherLib));
    await client`delete from releases where id = any(${madeReleases}::uuid[])`;
    await db.delete(releaseGroups).where(eq(releaseGroups.id, rgId));
    await client`delete from users where id = any(${[owner, editor]}::uuid[])`;
    await client.end({ timeout: 5 });
  });

  it('lists batches newest first with their counts, who ran them and the drain estimate', async () => {
    const body = await get(`/api/v1/libraries/${lib}/batches`);
    expect(body.items[0]).toMatchObject({
      id: modelBatch, deciderLabel: 'Jev 2026-09', decidedKind: 'model', band: 'high', state: 'accepted', startedBy: 'Ada',
      counts: { accepted: 2, skipped: 2, left: 1, undone: 0, pending: 0 }, failedDuring: null,
    });
    expect(body.items[0].drain).toMatchObject({ limit: 400, perNight: 2000, pending: 2, nights: 1 });
    expect(body.items[1]).toMatchObject({ id: ruleBatch, deciderLabel: 'Your rules', decidedKind: 'rule', counts: { accepted: 1 } });
    expect(typeof body.items[0].createdAt).toBe('string');
  });

  it('shows what was skipped or left, by label, and what cannot be undone', async () => {
    const d = await get(`/api/v1/libraries/${lib}/batches/${modelBatch}`);
    expect(d.cannotUndo).toEqual(['Album identity already pulled by linked apps', 'Tag plans already applied']);
    expect(d.skipped).toEqual([
      { albumId: skippedAlbum, title: `Title ${skippedAlbum.slice(0, 4)}`, artist: 'Batch Artist', reason: 'Identified again' },
      expect.objectContaining({ title: null, artist: null, reason: 'Album gone' }),
    ]);
    expect(d.left).toEqual([expect.objectContaining({ albumId: leftAlbum, reason: 'Newer decision' })]);
    expect(d.drain).toMatchObject({ pending: 2 });
  });

  it('a batch of another library, or none, is not found', async () => {
    expect((await req('GET', `/api/v1/libraries/${otherLib}/batches/${modelBatch}`)).statusCode).toBe(404);
    expect((await req('GET', `/api/v1/libraries/${lib}/batches/${randomUUID()}`)).statusCode).toBe(404);
    expect((await req('GET', `/api/v1/libraries/${lib}/batches/not-an-id`)).statusCode).toBe(404);
    expect((await post(`/api/v1/libraries/${otherLib}/batches/${ruleBatch}/undo`, {})).statusCode).toBe(404);
  });

  it('undo queues decider.accept in undo mode', async () => {
    const r = await post(`/api/v1/libraries/${lib}/batches/${ruleBatch}/undo`, {});
    expect(r.statusCode).toBe(202);
    expect(r.json()).toEqual({ ok: true });
    expect(boss.send).toHaveBeenCalledWith('decider.accept', { batchId: ruleBatch, mode: 'undo' }, { singletonKey: `decider:${ruleBatch}` });
    expect(await getBatch(client, ruleBatch)).toMatchObject({ state: 'undoing', undoByUserId: owner });
    expect((await getBatch(client, ruleBatch))!.undoRequestedAt).not.toBeNull();
  });

  it('an undoing batch reads its pending albums as not reached', async () => {
    const d = await get(`/api/v1/libraries/${lib}/batches/${ruleBatch}`);
    expect(d).toMatchObject({ state: 'undoing', pendingLabel: 'Not reached' });
  });

  it('an editor cannot undo a model batch', async () => {
    expect((await postAs(editor, `/api/v1/libraries/${lib}/batches/${modelBatch}/undo`, {})).statusCode).toBe(403);
    expect((await getBatch(client, modelBatch))!.state).toBe('accepted');
    expect(boss.send).not.toHaveBeenCalled();
  });

  it('an editor can undo a rule batch', async () => {
    const b = await acceptedRuleBatch();
    expect((await postAs(editor, `/api/v1/libraries/${lib}/batches/${b}/undo`, {})).statusCode).toBe(202);
    expect(await getBatch(client, b)).toMatchObject({ state: 'undoing', undoByUserId: editor });
  });

  it('an undone or still queued batch cannot be undone', async () => {
    const b = await acceptedRuleBatch();
    await transitionBatch(client, b, ['accepted'], 'undone');
    expect((await post(`/api/v1/libraries/${lib}/batches/${b}/undo`, {})).statusCode).toBe(409);
    const q = await createBatch(client, { libraryId: lib, deciderId: 'rules', deciderVersion: null, decidedKind: 'rule', startedByUserId: owner, items: [] });
    expect((await post(`/api/v1/libraries/${lib}/batches/${q}/undo`, {})).statusCode).toBe(409);
    expect(boss.send).not.toHaveBeenCalled();
  });

  it('an undo the queue already holds is accepted', async () => {
    const b = await acceptedRuleBatch();
    await queuedJob(b, 'created', 'undo');
    boss.send.mockResolvedValueOnce(null);
    expect((await post(`/api/v1/libraries/${lib}/batches/${b}/undo`, {})).statusCode).toBe(202);
    expect(boss.cancel).not.toHaveBeenCalled();
  });

  it('a queued accept run in the way is cancelled and the undo queued in its place', async () => {
    const b = await acceptedRuleBatch();
    const accept = await queuedJob(b, 'created', 'accept');
    boss.send.mockResolvedValueOnce(null).mockResolvedValueOnce('undo-job');
    expect((await post(`/api/v1/libraries/${lib}/batches/${b}/undo`, {})).statusCode).toBe(202);
    expect(boss.cancel).toHaveBeenCalledWith('decider.accept', [accept]);
    expect(boss.send).toHaveBeenCalledTimes(2);
  });

  it('an undo that could not be queued says so, and asking again queues it', async () => {
    const b = await acceptedRuleBatch();
    boss.send.mockResolvedValueOnce(null);
    expect((await post(`/api/v1/libraries/${lib}/batches/${b}/undo`, {})).statusCode).toBe(503);
    expect((await getBatch(client, b))!.state).toBe('undoing');
    const again = await post(`/api/v1/libraries/${lib}/batches/${b}/undo`, {});
    expect(again.statusCode).toBe(202);
    expect(boss.send).toHaveBeenLastCalledWith('decider.accept', { batchId: b, mode: 'undo' }, { singletonKey: `decider:${b}` });
  });

  it('a failed batch says whether the accept or the undo stopped', async () => {
    const b = await acceptedRuleBatch();
    await client`update decider_batches set state = 'failed', message = 'Undo stopped: boom' where id = ${b}`;
    expect(await get(`/api/v1/libraries/${lib}/batches/${b}`)).toMatchObject({ state: 'failed', failedDuring: 'undo', message: 'Undo stopped: boom', drain: null });
    await client`update decider_batches set message = 'Accept stopped: boom' where id = ${b}`;
    expect(await get(`/api/v1/libraries/${lib}/batches/${b}`)).toMatchObject({ failedDuring: 'accept' });
  });

  it('the list and the view fail a batch whose run died, so it never reads accepting for hours', async () => {
    const b = await acceptedRuleBatch();
    await client`update decider_batches set state = 'accepting', created_at = now() - interval '7 hours' where id = ${b}`;
    await client`update decider_batch_items set accepted_at = now() - interval '7 hours' where batch_id = ${b}`;
    const listed = (await get(`/api/v1/libraries/${lib}/batches`)).items.find((x: any) => x.id === b);
    expect(listed).toMatchObject({ state: 'failed', failedDuring: 'accept', message: 'Accept stopped: no progress' });
    const u = await acceptedRuleBatch();
    await client`update decider_batches set state = 'undoing', created_at = now() - interval '9 hours', undo_requested_at = now() - interval '7 hours' where id = ${u}`;
    await client`update decider_batch_items set accepted_at = now() - interval '9 hours' where batch_id = ${u}`;
    expect(await get(`/api/v1/libraries/${lib}/batches/${u}`)).toMatchObject({ state: 'failed', failedDuring: 'undo', message: 'Undo stopped: no progress' });
  });

  it('an undo asked again renews its time, so the stale check leaves it to the run just queued', async () => {
    const b = await acceptedRuleBatch();
    await client`update decider_batches set state = 'undoing', created_at = now() - interval '9 hours', undo_requested_at = now() - interval '7 hours' where id = ${b}`;
    await client`update decider_batch_items set accepted_at = now() - interval '9 hours' where batch_id = ${b}`;
    expect((await post(`/api/v1/libraries/${lib}/batches/${b}/undo`, {})).statusCode).toBe(202);
    const after = (await getBatch(client, b))!;
    expect(after.state).toBe('undoing');
    expect(Date.now() - after.undoRequestedAt!.getTime()).toBeLessThan(60_000);
    expect((await get(`/api/v1/libraries/${lib}/batches/${b}`)).state).toBe('undoing');
  });

  it('drain faster doubles the pace and halves the nights', async () => {
    const r = await put(`/api/v1/libraries/${lib}/enrich-pace`, { limit: 800 });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ limit: 800, drain: { perNight: 4000 } });
    const [s] = await client`select settings->'enrichSweepLimit' as l from libraries where id = ${lib}`;
    expect(s.l).toBe(800);
    expect((await put(`/api/v1/libraries/${lib}/enrich-pace`, { limit: 500 })).statusCode).toBe(400);
    expect((await put(`/api/v1/libraries/${lib}/enrich-pace`, {})).statusCode).toBe(400);
    expect((await put(`/api/v1/libraries/${randomUUID()}/enrich-pace`, { limit: 400 })).statusCode).toBe(404);
    const listed = (await get(`/api/v1/libraries/${lib}/batches`)).items.find((b: any) => b.id === modelBatch);
    expect(listed.drain).toMatchObject({ limit: 800, perNight: 4000, nights: 1 });
  });
});
