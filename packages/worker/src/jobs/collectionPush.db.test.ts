/**
 * collection.push / collection.remove against a real database with Discogs
 * mocked at the providers boundary: a push adds one Discogs instance and
 * never a second, an Undo that lands while Discogs is answering takes the new
 * instance back off, and a failed removal is marked so Retry removes again.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { collectionItems, collectionSources, libraries, users, makeDb } from '@liner/db';
import pino from 'pino';
import type { WorkerContext } from '../lib/context.js';
import { collectionPushJob, collectionRemoveJob } from './collectionSync.js';

const discogs = vi.hoisted(() => ({
  getIdentity: vi.fn(async () => ({ username: 'owner' })),
  getCollectionFields: vi.fn(async () => []),
  addToCollection: vi.fn(async (): Promise<{ instanceId: number }> => ({ instanceId: 2189264288 })),
  removeFromCollection: vi.fn(async () => undefined),
  getRelease: vi.fn(async () => { throw new Error('not needed here'); }),
  setCollectionField: vi.fn(),
  setCollectionRating: vi.fn(),
}));

vi.mock('../lib/providers.js', () => ({
  libraryProviderSettings: vi.fn(async () => ({ contactString: 'test@example.com', discogsToken: 'mock' })),
  getProviders: vi.fn(() => ({ discogs })),
  discogsCall: vi.fn((_ctx: unknown, _p: unknown, fn: () => Promise<unknown>) => fn()),
  mbCall: vi.fn((_ctx: unknown, fn: () => Promise<unknown>) => fn()),
}));

describe.skipIf(!process.env.TEST_DATABASE_URL)('collection push and remove (db)', () => {
  let ctx: WorkerContext;
  let db: any;
  let client: any;
  const userId = randomUUID();
  const libraryId = randomUUID();
  let sourceId: string;

  beforeAll(async () => {
    const databaseUrl = process.env.TEST_DATABASE_URL;
    if (!databaseUrl) throw new Error('TEST_DATABASE_URL not set — these suites delete rows and must never run against DATABASE_URL');
    const made = await makeDb(databaseUrl);
    db = made.db;
    client = made.client;
    ctx = { db: made.db, sql: made.client, boss: null as any, logger: pino({ level: 'silent' }) };
    await db.insert(users).values({ id: userId, email: `push-${userId}@test.com`, passwordHash: 'x' });
    await db.insert(libraries).values({ id: libraryId, name: 'Push test', ownerUserId: userId });
    const [src] = await db.insert(collectionSources).values({ libraryId, provider: 'discogs', fields: [] }).returning();
    sourceId = src.id;
  });

  afterAll(async () => {
    if (db) {
      await db.delete(libraries).where(eq(libraries.id, libraryId));
      await db.delete(users).where(eq(users.id, userId));
    }
    await client?.end();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    await db.delete(collectionItems).where(eq(collectionItems.libraryId, libraryId));
  });

  const seed = async (extra: Record<string, unknown> = {}) => {
    const id = randomUUID();
    await db.insert(collectionItems).values({
      id, libraryId, collectionSourceId: sourceId, discogsReleaseId: 3717454, folderId: 1, mappingState: 'manual', pushState: 'pending', ...extra,
    });
    return id;
  };
  const row = async (id: string) => (await db.select().from(collectionItems).where(eq(collectionItems.id, id)))[0];

  it('adds the record to Discogs once and keeps the instance id', async () => {
    const id = await seed();
    await collectionPushJob(ctx, { libraryId, itemId: id });
    expect(discogs.addToCollection).toHaveBeenCalledTimes(1);
    expect(await row(id)).toMatchObject({ providerItemId: '2189264288', pushState: 'synced' });
  });

  it('never adds a second Discogs instance for an item that already has one', async () => {
    const id = await seed({ providerItemId: '2189264288', pushState: 'failed', pushError: 'Failed to set notes' });
    await collectionPushJob(ctx, { libraryId, itemId: id });
    expect(discogs.addToCollection).not.toHaveBeenCalled();
    expect(await row(id)).toMatchObject({ providerItemId: '2189264288', pushState: 'synced', pushError: null });
  });

  it('takes the instance back off Discogs when the owner undid the add mid-push', async () => {
    const id = await seed();
    discogs.addToCollection.mockImplementationOnce(async () => {
      await db.delete(collectionItems).where(eq(collectionItems.id, id));
      return { instanceId: 555 };
    });
    await collectionPushJob(ctx, { libraryId, itemId: id });
    expect(discogs.removeFromCollection).toHaveBeenCalledWith('owner', 1, 3717454, 555, expect.anything());
  });

  it('removes an instance from Discogs and marks the item removed', async () => {
    const id = await seed({ providerItemId: '2189264320', pushState: 'removing' });
    await collectionRemoveJob(ctx, { libraryId, itemId: id });
    expect(discogs.removeFromCollection).toHaveBeenCalledWith('owner', 1, 3717454, 2189264320, expect.anything());
    const r = await row(id);
    expect(r.removedAt).not.toBeNull();
    expect(r.pushState).toBe('synced');
  });

  it('marks a failed removal so Retry removes again instead of adding', async () => {
    const id = await seed({ providerItemId: '2189264320', pushState: 'removing' });
    discogs.removeFromCollection.mockRejectedValueOnce(Object.assign(new Error('Discogs 500'), { status: 500 }));
    await collectionRemoveJob(ctx, { libraryId, itemId: id });
    const r = await row(id);
    expect(r.pushState).toBe('failed');
    expect(r.pushError).toMatch(/^Removing from Discogs failed: Discogs 500/);
    expect(r.removedAt).toBeNull();
  });
});
