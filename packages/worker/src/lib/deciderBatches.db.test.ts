/**
 * Accept batches and their per-album snapshots (0071), against a real
 * database: creating a batch with its items, reading them back in order,
 * the counts, the state stamps, and what deleting a library or an album does.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, getTableColumns } from 'drizzle-orm';
import {
  BATCH_CANNOT_UNDO, batchCounts, createBatch, deciderBatches, deciderBatchItems, getBatch, itemsWithStatus,
  libraries, localAlbums, makeDb, requestUndo, sendDeciderAccept, setBatchState, transitionBatch, users, type BatchItemInput,
} from '@tagave/db';

describe.skipIf(!process.env.TEST_DATABASE_URL)('decider batches (db)', () => {
  let db: any;
  let client: any;
  const userId = randomUUID();
  const libraryId = randomUUID();
  const otherLibrary = randomUUID();

  const item = (albumId: string, over: Partial<BatchItemInput> = {}): BatchItemInput => ({
    albumId, releaseId: randomUUID(), distance: 0.0312, source: 'mb_search', probability: 0.9871,
    evidenceHash: 'a'.repeat(64), expectLastIdentifyAt: '2026-10-01T12:00:00.000Z', reason: 'model accept: test', ...over,
  });
  const base = { libraryId, deciderId: 'jev', deciderVersion: 'jev-2026-09-15', decidedKind: 'model' as const, startedByUserId: userId };

  beforeAll(async () => {
    const made = await makeDb(process.env.TEST_DATABASE_URL!);
    db = made.db;
    client = made.client;
    await db.insert(users).values({ id: userId, email: `db-${userId}@test.com`, passwordHash: 'x' });
    for (const id of [libraryId, otherLibrary]) await db.insert(libraries).values({ id, name: 'Batches', ownerUserId: userId, settings: {} });
  });

  afterAll(async () => {
    await db.delete(libraries).where(eq(libraries.id, libraryId));
    await db.delete(libraries).where(eq(libraries.id, otherLibrary));
    await db.delete(users).where(eq(users.id, userId));
    await client.end({ timeout: 5 });
  });

  it('creates a queued batch whose items read back pending, in insertion order', async () => {
    const a = randomUUID(); const b = randomUUID(); const c = randomUUID();
    const id = await createBatch(client, { ...base, runId: randomUUID(), band: 'high', items: [item(a), item(b, { probability: null, source: null }), item(c)] });
    const batch = await getBatch(client, id);
    expect(batch).toMatchObject({ id, libraryId, deciderId: 'jev', deciderVersion: 'jev-2026-09-15', decidedKind: 'model', band: 'high', acceptFrom: ['needs_review'], state: 'queued', startedByUserId: userId, acceptedAt: null, undoneAt: null });
    expect(batch!.createdAt).toBeInstanceOf(Date);
    const items = await itemsWithStatus(client, id, 'pending', 10);
    expect(items.map((i) => i.localAlbumId)).toEqual([a, b, c]);
    expect(items[0]).toMatchObject({ batchId: id, distance: 0.0312, probability: 0.9871, source: 'mb_search', evidenceHash: 'a'.repeat(64), status: 'pending', skipReason: null, matchId: null, priorState: null, acceptedAt: null });
    expect(items[0]!.expectLastIdentifyAt?.toISOString()).toBe('2026-10-01T12:00:00.000Z');
    expect(items[1]).toMatchObject({ probability: null, source: null });
    expect((await itemsWithStatus(client, id, 'pending', 2)).map((i) => i.localAlbumId)).toEqual([a, b]);
  });

  it('refuses a model batch with an item not pinned to its evidence or identify time, and keeps nothing', async () => {
    const before = (await client`select count(*)::int as n from decider_batches where library_id = ${libraryId}`)[0].n;
    await expect(createBatch(client, { ...base, items: [item(randomUUID()), item(randomUUID(), { evidenceHash: null })] })).rejects.toBeInstanceOf(RangeError);
    await expect(createBatch(client, { ...base, items: [item(randomUUID(), { expectLastIdentifyAt: null })] })).rejects.toThrow(/item 1/);
    expect((await client`select count(*)::int as n from decider_batches where library_id = ${libraryId}`)[0].n).toBe(before);
  });

  it('lets a rule batch leave the evidence hash and identify time empty', async () => {
    const a = randomUUID();
    const id = await createBatch(client, { ...base, decidedKind: 'rule', deciderId: 'rules', deciderVersion: null, items: [item(a, { evidenceHash: null, expectLastIdentifyAt: null, probability: null })] });
    expect((await itemsWithStatus(client, id, 'pending', 1))[0]).toMatchObject({ localAlbumId: a, evidenceHash: null, expectLastIdentifyAt: null });
  });

  it('moves a batch only from the states it is asked to move it from', async () => {
    const id = await createBatch(client, { ...base, items: [item(randomUUID())] });
    expect(await transitionBatch(client, id, ['accepting'], 'accepted')).toBe(false);
    expect((await getBatch(client, id))!).toMatchObject({ state: 'queued', acceptedAt: null });
    expect(await transitionBatch(client, id, ['queued', 'accepting'], 'accepting')).toBe(true);
    expect(await transitionBatch(client, id, ['accepting'], 'accepted', { message: '1 accepted, 0 skipped' })).toBe(true);
    const [row] = await client`select state, message, accepted_at from decider_batches where id = ${id}`;
    expect(row).toMatchObject({ state: 'accepted', message: '1 accepted, 0 skipped' });
    expect(row.accepted_at).not.toBeNull();
    expect(await transitionBatch(client, randomUUID(), ['queued'], 'accepting')).toBe(false);
  });

  it('queues every run of one batch under the batch key, with no throttle window', async () => {
    const calls: unknown[][] = [];
    const boss = { send: async (...a: unknown[]) => { calls.push(a); return 'job'; } };
    const id = randomUUID();
    await sendDeciderAccept(boss, id);
    await sendDeciderAccept(boss, id, 'undo');
    expect(calls).toEqual([
      ['decider.accept', { batchId: id, mode: 'accept' }, { singletonKey: `decider:${id}` }],
      ['decider.accept', { batchId: id, mode: 'undo' }, { singletonKey: `decider:${id}` }],
    ]);
  });

  it('keeps a larger batch in insertion order, by position', async () => {
    const albums = Array.from({ length: 120 }, () => randomUUID());
    const id = await createBatch(client, { ...base, decidedKind: 'rule', deciderId: 'rules', deciderVersion: null, items: albums.map((x) => item(x)) });
    const stored = await client`select local_album_id, position from decider_batch_items where batch_id = ${id} order by position`;
    expect(stored.map((r: any) => r.local_album_id)).toEqual(albums);
    expect(stored.map((r: any) => r.position)).toEqual(albums.map((_, i) => i + 1));
    expect((await itemsWithStatus(client, id, 'pending', 500)).map((i) => i.localAlbumId)).toEqual(albums);
  });

  it('counts two pending items and nothing else', async () => {
    const id = await createBatch(client, { ...base, items: [item(randomUUID()), item(randomUUID())] });
    expect(await batchCounts(client, id)).toEqual({ pending: 2, accepted: 0, skipped: 0, undone: 0, left: 0, skipped_by: {}, left_by: {} });
  });

  it('counts skipped and left items by their reason', async () => {
    const ids = Array.from({ length: 5 }, () => randomUUID());
    const id = await createBatch(client, { ...base, items: ids.map((x) => item(x)) });
    await client`update decider_batch_items set status = 'skipped', skip_reason = 'gone' where batch_id = ${id} and local_album_id = any(${ids.slice(0, 2)}::uuid[])`;
    await client`update decider_batch_items set status = 'left', skip_reason = 'locks' where batch_id = ${id} and local_album_id = ${ids[2]!}`;
    await client`update decider_batch_items set status = 'accepted' where batch_id = ${id} and local_album_id = ${ids[3]!}`;
    expect(await batchCounts(client, id)).toEqual({ pending: 1, accepted: 1, skipped: 2, undone: 0, left: 1, skipped_by: { gone: 2 }, left_by: { locks: 1 } });
  });

  it('refuses the same album twice in one batch, and keeps nothing of it', async () => {
    const a = randomUUID();
    const runId = randomUUID();
    await expect(createBatch(client, { ...base, runId, items: [item(a), item(a)] })).rejects.toThrow(/unique|duplicate/i);
    expect((await client`select 1 from decider_batches where run_id = ${runId}`).length).toBe(0);
  });

  it('takes the accept-from states it is given', async () => {
    const id = await createBatch(client, { ...base, acceptFrom: ['needs_review', 'unidentified'], items: [] });
    expect((await getBatch(client, id))!.acceptFrom).toEqual(['needs_review', 'unidentified']);
  });

  it('stamps accepted_at and undone_at as the state moves, and keeps a message', async () => {
    const id = await createBatch(client, { ...base, items: [item(randomUUID())] });
    await setBatchState(client, id, 'accepting');
    expect((await getBatch(client, id))).toMatchObject({ state: 'accepting', acceptedAt: null });
    await setBatchState(client, id, 'accepted', { message: '1 accepted' });
    const accepted = (await getBatch(client, id))!;
    expect(accepted.state).toBe('accepted');
    expect(accepted.acceptedAt).toBeInstanceOf(Date);
    await setBatchState(client, id, 'undone');
    const undone = (await getBatch(client, id))!;
    expect(undone.undoneAt).toBeInstanceOf(Date);
    expect(undone.acceptedAt?.getTime()).toBe(accepted.acceptedAt!.getTime());
    expect((await client`select message from decider_batches where id = ${id}`)[0].message).toBe('1 accepted');
    await expect(setBatchState(client, id, 'bogus' as never)).rejects.toThrow(/check/);
  });

  it('getBatch returns null for an unknown batch', async () => {
    expect(await getBatch(client, randomUUID())).toBeNull();
  });

  it('deleting the library removes its batches and their items', async () => {
    const id = await createBatch(client, { ...base, libraryId: otherLibrary, items: [item(randomUUID())] });
    await db.delete(libraries).where(eq(libraries.id, otherLibrary));
    expect(await getBatch(client, id)).toBeNull();
    expect((await client`select 1 from decider_batch_items where batch_id = ${id}`).length).toBe(0);
  });

  it('deleting an album keeps its item, so the batch can report it gone', async () => {
    const albumId = randomUUID();
    await db.insert(localAlbums).values({ id: albumId, libraryId, clusterKey: `k-${albumId}`, dirPaths: [`x/${albumId}`], state: 'needs_review', trackCount: 1 });
    const id = await createBatch(client, { ...base, items: [item(albumId)] });
    await db.delete(localAlbums).where(eq(localAlbums.id, albumId));
    expect((await itemsWithStatus(client, id, 'pending', 10)).map((i) => i.localAlbumId)).toEqual([albumId]);
  });

  it('refuses a probability outside 0..1', async () => {
    await expect(createBatch(client, { ...base, items: [item(randomUUID(), { probability: 1.5 })] })).rejects.toThrow(/decider_batch_items_probability_check/);
  });

  it('a skipped or left item must say why, and only those may', async () => {
    const a = randomUUID(); const b = randomUUID();
    const id = await createBatch(client, { ...base, items: [item(a), item(b)] });
    await expect(client`update decider_batch_items set status = 'skipped' where batch_id = ${id} and local_album_id = ${a}`).rejects.toThrow(/decider_batch_items_skip_reason_set/);
    await expect(client`update decider_batch_items set status = 'left' where batch_id = ${id} and local_album_id = ${a}`).rejects.toThrow(/decider_batch_items_skip_reason_set/);
    await expect(client`update decider_batch_items set skip_reason = 'gone' where batch_id = ${id} and local_album_id = ${a}`).rejects.toThrow(/decider_batch_items_skip_reason_set/);
    await client`update decider_batch_items set status = 'skipped', skip_reason = 'evidence_changed' where batch_id = ${id} and local_album_id = ${a}`;
    await client`update decider_batch_items set status = 'left', skip_reason = 'tag_plan' where batch_id = ${id} and local_album_id = ${b}`;
    expect(await batchCounts(client, id)).toMatchObject({ skipped: 1, left: 1, skipped_by: { evidence_changed: 1 }, left_by: { tag_plan: 1 } });
  });

  it('refuses a skip reason outside the known ones', async () => {
    const a = randomUUID();
    const id = await createBatch(client, { ...base, items: [item(a)] });
    await expect(client`update decider_batch_items set status = 'skipped', skip_reason = 'bored' where batch_id = ${id} and local_album_id = ${a}`).rejects.toThrow(/decider_batch_items_skip_reason_check/);
  });

  it('the drizzle schema has every column 0071 made', async () => {
    const tables = { decider_batches: deciderBatches, decider_batch_items: deciderBatchItems };
    for (const [name, table] of Object.entries(tables)) {
      const inDb = (await client`select column_name as c from information_schema.columns where table_schema = 'public' and table_name = ${name}`).map((r: { c: string }) => r.c).sort();
      const inSchema = Object.values(getTableColumns(table)).map((c) => c.name).sort();
      expect(inDb.length, name).toBeGreaterThan(0);
      expect(inSchema, name).toEqual(inDb);
    }
  });

  it('an undo request moves an accepting, accepted or failed batch to undoing and says who asked', async () => {
    for (const from of ['accepting', 'accepted', 'failed'] as const) {
      const id = await createBatch(client, { ...base, items: [item(randomUUID())] });
      await setBatchState(client, id, from, { message: 'before' });
      expect(await requestUndo(client, id, userId)).toBe(true);
      const b = await getBatch(client, id);
      expect(b).toMatchObject({ state: 'undoing', undoByUserId: userId, message: 'before' });
      expect(b!.undoRequestedAt).toBeInstanceOf(Date);
    }
    for (const from of ['queued', 'undoing', 'undone'] as const) {
      const id = await createBatch(client, { ...base, items: [item(randomUUID())] });
      await setBatchState(client, id, from);
      expect(await requestUndo(client, id, userId)).toBe(false);
      expect((await getBatch(client, id))!).toMatchObject({ state: from, undoRequestedAt: null, undoByUserId: null });
    }
    expect(await requestUndo(client, randomUUID(), userId)).toBe(false);
  });

  it('names what an undo cannot take back', () => {
    expect(BATCH_CANNOT_UNDO).toEqual(['Album identity already pulled by linked apps', 'Tag plans already applied']);
  });
});
