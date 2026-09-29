/**
 * The physical collection against a real database: "I own this on vinyl/CD"
 * links the new item to the album at once, a double submit adds one item and
 * queues one Discogs push, an older copy answers "already owned" until the
 * owner asks for another copy, duplicates are found and removed from Discogs
 * through collection.remove, and unmapped records get one-click suggestions.
 * Discogs is never called: pg-boss is mocked and the push job is not run.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import { collectionItems, collectionSources, libraries, localAlbums, releaseGroups, releases, users } from '@liner/db';

const boss = vi.hoisted(() => ({
  createQueue: vi.fn(async () => undefined),
  send: vi.fn(async (): Promise<string | null> => 'boss-job-1'),
}));
vi.mock('../boss.js', () => ({ getBoss: async () => boss }));

describe.skipIf(!process.env.TEST_DATABASE_URL)('physical collection (db)', () => {
  let app: FastifyInstance;
  let db: ReturnType<typeof import('../db.js')['getDb']>;
  let client: { end: () => Promise<void> };
  const userId = randomUUID();
  const libraryId = randomUUID();
  const rgId = randomUUID();
  const relId = randomUUID();
  const albumId = randomUUID();
  const otherAlbumId = randomUUID();
  const unidentifiedAlbumId = randomUUID();
  // unique per run: releases.discogs_release_id is unique across the shared test db
  const discogsId = 900_000_000 + Math.floor(Math.random() * 90_000_000);
  const pushes = () => boss.send.mock.calls.filter((c) => (c as unknown[])[0] === 'collection.push');
  const items = () => db.select().from(collectionItems).where(eq(collectionItems.libraryId, libraryId));

  beforeAll(async () => {
    const dbUrl = process.env.TEST_DATABASE_URL;
    if (!dbUrl) throw new Error('TEST_DATABASE_URL not set — these suites delete rows and must never run against DATABASE_URL');
    const { initDb, getDb } = await import('../db.js');
    const conn = await initDb(dbUrl);
    client = conn.client;
    db = getDb();
    await db.insert(users).values({ id: userId, email: `physical-${userId}@test.com`, passwordHash: 'x' });
    await db.insert(libraries).values({ id: libraryId, name: 'Physical test', ownerUserId: userId });
    await db.insert(releaseGroups).values({ id: rgId, mbid: randomUUID(), title: 'Yellow & Green', primaryType: 'Album' });
    await db.insert(releases).values({ id: relId, mbid: randomUUID(), releaseGroupId: rgId, title: 'Yellow & Green', discogsReleaseId: discogsId, trackCount: 18 });
    await db.insert(localAlbums).values([
      { id: albumId, libraryId, clusterKey: `p-${albumId}`, dirPaths: ['Baroness/Yellow & Green'], titleGuess: 'Yellow & Green', artistGuess: 'Baroness',
        yearGuess: 2012, trackCount: 18, state: 'matched', releaseId: relId, releaseGroupId: rgId },
      { id: otherAlbumId, libraryId, clusterKey: `p-${otherAlbumId}`, dirPaths: ['Baroness/Purple'], titleGuess: 'Purple', artistGuess: 'Baroness',
        yearGuess: 2015, trackCount: 10, state: 'matched' },
      { id: unidentifiedAlbumId, libraryId, clusterKey: `p-${unidentifiedAlbumId}`, dirPaths: ['Unknown/Tape'], titleGuess: 'Tape', artistGuess: 'Someone', state: 'pending' },
    ]);

    const { errorHandler } = await import('../middleware/errorHandler.js');
    const { createCollectionRoutes } = await import('./collection.js');
    app = Fastify();
    await errorHandler(app);
    app.addHook('preHandler', async (request) => {
      request.user = { id: userId, email: 'owner@test.com', displayName: 'Owner', role: 'owner', createdAt: new Date().toISOString() };
    });
    await app.register(createCollectionRoutes, { prefix: '/api/v1' });
    await app.ready();
  });

  afterAll(async () => {
    if (app) await app.close();
    if (!db) return;
    await db.delete(libraries).where(eq(libraries.id, libraryId)); // cascades items, sources, albums
    await db.delete(releaseGroups).where(eq(releaseGroups.id, rgId)); // cascades the release
    await db.delete(users).where(eq(users.id, userId));
    await client.end();
  });

  beforeEach(async () => {
    boss.send.mockClear();
    await db.delete(collectionItems).where(eq(collectionItems.libraryId, libraryId));
  });

  const addFromAlbum = (payload: Record<string, unknown> = {}, id = albumId) =>
    app.inject({ method: 'POST', url: `/api/v1/libraries/${libraryId}/albums/${id}/collection`, payload: { discogsReleaseId: discogsId, ...payload } });

  it('links a copy added from an album to that album, its release and release group', async () => {
    const res = await addFromAlbum();
    expect(res.statusCode).toBe(202);
    const { itemId, created } = res.json() as { itemId: string; created: boolean };
    expect(created).toBe(true);
    const [row] = await items();
    expect(row).toMatchObject({
      id: itemId, discogsReleaseId: discogsId, releaseId: relId, releaseGroupId: rgId, localAlbumId: albumId,
      mappingState: 'manual', mappingSource: 'owner', pushState: 'pending',
    });
    expect(pushes()).toHaveLength(1);
    // the album now reads as physical + digital: "Both", not "Unmapped"
    const both = await app.inject({ method: 'GET', url: `/api/v1/libraries/${libraryId}/collection?view=both` });
    expect((both.json() as { items: Array<{ id: string }> }).items.map((i) => i.id)).toEqual([itemId]);
    const unmapped = await app.inject({ method: 'GET', url: `/api/v1/libraries/${libraryId}/collection?view=unmapped` });
    expect((unmapped.json() as { items: unknown[] }).items).toHaveLength(0);
    // facets are marked stale so the grid's "owned" facet recounts
    const [fs] = await db.execute(sql`select dirty_at from facet_state where library_id = ${libraryId}`) as unknown as Array<{ dirty_at: unknown }>;
    expect(fs?.dirty_at).toBeTruthy();
  });

  it('links an album that has no release group by the album alone', async () => {
    const res = await addFromAlbum({ discogsReleaseId: discogsId + 1 }, unidentifiedAlbumId);
    expect(res.statusCode).toBe(202);
    const [row] = await items();
    expect(row).toMatchObject({ localAlbumId: unidentifiedAlbumId, releaseGroupId: null, mappingState: 'manual' });
  });

  it('adds one item and queues one push when the same click arrives twice', async () => {
    const [a, b] = await Promise.all([addFromAlbum(), addFromAlbum()]);
    const ids = [a, b].map((r) => (r.json() as { itemId: string }).itemId);
    expect(ids[0]).toBe(ids[1]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 202]);
    expect(await items()).toHaveLength(1);
    expect(pushes()).toHaveLength(1);
  });

  it('answers "already owned" for an older copy, and adds another copy only when asked', async () => {
    const first = await addFromAlbum();
    const firstId = (first.json() as { itemId: string }).itemId;
    await db.update(collectionItems)
      .set({ createdAt: new Date(Date.now() - 60 * 60_000), formats: [{ name: 'CD', qty: '1' }] })
      .where(eq(collectionItems.id, firstId));
    boss.send.mockClear();

    const again = await addFromAlbum();
    expect(again.statusCode).toBe(409);
    const body = again.json() as { code: string; detail: string; existing: Array<{ id: string; format: string }> };
    expect(body.code).toBe('already_owned');
    expect(body.detail).toBe('You already have this on CD.');
    expect(body.existing.map((e) => e.id)).toEqual([firstId]);
    expect(pushes()).toHaveLength(0);

    const another = await addFromAlbum({ anotherCopy: true });
    expect(another.statusCode).toBe(202);
    expect(await items()).toHaveLength(2);
    expect(pushes()).toHaveLength(1);
    // the yes itself landing twice still adds one copy
    const yesAgain = await addFromAlbum({ anotherCopy: true });
    expect(yesAgain.statusCode).toBe(200);
    expect(await items()).toHaveLength(2);
  });

  it('links a copy added by Discogs URL when tagave knows the release', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/v1/libraries/${libraryId}/collection/items`, payload: { input: `https://www.discogs.com/release/${discogsId}-Baroness-Yellow-Green` } });
    expect(res.statusCode).toBe(202);
    const [row] = await items();
    expect(row).toMatchObject({ releaseId: relId, releaseGroupId: rgId, localAlbumId: albumId, mappingState: 'auto', mappingSource: 'release_id' });
  });

  describe('duplicates', () => {
    const seedTwins = async () => {
      const [src] = await db.select().from(collectionSources).where(eq(collectionSources.libraryId, libraryId));
      const sourceId = src?.id ?? (await db.insert(collectionSources).values({ libraryId, provider: 'discogs' }).returning())[0]!.id;
      const older = randomUUID();
      const newer = randomUUID();
      const base = {
        libraryId, collectionSourceId: sourceId, discogsReleaseId: discogsId + 7, mappingState: 'unmapped', pushState: 'synced',
        basicInfo: { title: 'Yellow & Green', artists: ['Baroness'], year: 2012, formats: [{ name: 'CD', qty: '2' }] },
      };
      await db.insert(collectionItems).values([
        { ...base, id: older, providerItemId: `${discogsId}1`, createdAt: new Date(Date.now() - 10_000) },
        { ...base, id: newer, providerItemId: `${discogsId}2`, createdAt: new Date(Date.now() - 5_000) },
      ]);
      return { older, newer };
    };

    it('finds the extra copy and counts it', async () => {
      const { older, newer } = await seedTwins();
      const res = await app.inject({ method: 'GET', url: `/api/v1/libraries/${libraryId}/collection?view=duplicates` });
      const list = (res.json() as { items: Array<{ id: string; copies: number; duplicateOf: string | null; format: string }> }).items;
      expect(list.map((i) => i.id)).toEqual([older, newer]);
      expect(list.find((i) => i.id === newer)).toMatchObject({ copies: 2, duplicateOf: older, format: '2×CD' });
      expect(list.find((i) => i.id === older)?.duplicateOf).toBeNull();
      const sources = await app.inject({ method: 'GET', url: `/api/v1/libraries/${libraryId}/collection-sources` });
      const counts = (sources.json() as { sources: Array<{ counts: Record<string, number> }> }).sources[0]!.counts;
      expect(counts).toMatchObject({ duplicates: 1, unmapped: 2 });
    });

    it('removes the duplicate from Discogs through collection.remove', async () => {
      const { newer } = await seedTwins();
      const res = await app.inject({ method: 'DELETE', url: `/api/v1/collection-items/${newer}` });
      expect(res.statusCode).toBe(202);
      expect(boss.send).toHaveBeenCalledWith('collection.remove', { libraryId, itemId: newer }, expect.anything());
      const [row] = await db.select().from(collectionItems).where(eq(collectionItems.id, newer));
      expect(row?.pushState).toBe('removing');
    });
  });

  it('deletes a copy that never reached Discogs outright (Undo before the push)', async () => {
    const { itemId } = (await addFromAlbum()).json() as { itemId: string };
    const res = await app.inject({ method: 'DELETE', url: `/api/v1/collection-items/${itemId}` });
    expect(res.statusCode).toBe(202);
    expect(await items()).toHaveLength(0);
    expect(boss.send.mock.calls.some((c) => (c as unknown[])[0] === 'collection.remove')).toBe(false);
  });

  describe('unmapped records', () => {
    const seedUnmapped = async () => {
      const res = await app.inject({ method: 'POST', url: `/api/v1/libraries/${libraryId}/collection/items`, payload: { input: String(discogsId + 3) } });
      const { itemId } = res.json() as { itemId: string };
      await db.update(collectionItems)
        .set({ basicInfo: { title: 'Yellow & Green', artists: ['Baroness (2)'], year: 2012 } })
        .where(eq(collectionItems.id, itemId));
      return itemId;
    };

    it('suggests the matching album from the library first', async () => {
      const itemId = await seedUnmapped();
      const res = await app.inject({ method: 'GET', url: `/api/v1/collection-items/${itemId}/suggestions` });
      expect(res.statusCode).toBe(200);
      const { suggestions } = res.json() as { suggestions: Array<{ id: string; title: string; artist: string; year: number; trackCount: number }> };
      expect(suggestions[0]).toMatchObject({ id: albumId, title: 'Yellow & Green', artist: 'Baroness', year: 2012, trackCount: 18 });
      expect(suggestions.map((s) => s.id)).not.toContain(otherAlbumId);
    });

    it('links to the album the owner picked', async () => {
      const itemId = await seedUnmapped();
      const res = await app.inject({ method: 'POST', url: `/api/v1/collection-items/${itemId}/link`, payload: { localAlbumId: albumId } });
      expect(res.statusCode).toBe(200);
      const [row] = await db.select().from(collectionItems).where(eq(collectionItems.id, itemId));
      expect(row).toMatchObject({ localAlbumId: albumId, releaseId: relId, releaseGroupId: rgId, mappingState: 'manual', mappingSource: 'owner' });
    });

    it('keeps a record the owner says is not in the library as physical-only', async () => {
      const itemId = await seedUnmapped();
      await app.inject({ method: 'POST', url: `/api/v1/collection-items/${itemId}/link`, payload: { notInLibrary: true } });
      const res = await app.inject({ method: 'GET', url: `/api/v1/libraries/${libraryId}/collection?view=physical_only` });
      expect((res.json() as { items: Array<{ id: string }> }).items.map((i) => i.id)).toEqual([itemId]);
    });

    it('links by a pasted Discogs or MusicBrainz address tagave knows', async () => {
      const itemId = await seedUnmapped();
      const res = await app.inject({ method: 'POST', url: `/api/v1/collection-items/${itemId}/map`, payload: { input: `https://www.discogs.com/release/${discogsId}` } });
      expect(res.statusCode).toBe(200);
      const [row] = await db.select().from(collectionItems).where(eq(collectionItems.id, itemId));
      expect(row).toMatchObject({ releaseId: relId, localAlbumId: albumId, mappingState: 'manual' });
    });

    it('says so when the pasted release is unknown', async () => {
      const itemId = await seedUnmapped();
      const res = await app.inject({ method: 'POST', url: `/api/v1/collection-items/${itemId}/map`, payload: { input: 'https://www.discogs.com/release/1' } });
      expect(res.statusCode).toBe(404);
      expect((res.json() as { detail: string }).detail).toMatch(/does not know that release/);
    });
  });
});
