/**
 * Settings › Storage against the test database: the overview groups the
 * tables and walks the folders; the tag-change cleanup previews what it
 * frees and never deletes a plan that can still be reverted unless asked.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { eq, inArray } from 'drizzle-orm';
import { files, libraries, scanRoots, tagPlanItems, tagPlans, users } from '@tagave/db';
import type { StorageOverview, TagChangeCleanupPreview, TagChangeCleanupResult } from '@tagave/shared';

describe.skipIf(!process.env.TEST_DATABASE_URL)('storage routes', () => {
  let app: FastifyInstance;
  let db: any;
  let client: any;
  let cacheDir: string;
  const ownerId = randomUUID();
  const strangerId = randomUUID();
  const libraryId = randomUUID();
  const otherLibraryId = randomUUID();
  const rootId = randomUUID();
  const fileId = randomUUID();
  const policy = { preset: 'canonical_ids_and_fill', id3Version: '2.4', multiValueSeparator: '; ' };
  const scope = { type: 'library' };
  const ids: Record<string, string> = {};

  async function plan(key: string, status: string, opts: { archived?: boolean; applied?: boolean; library?: string } = {}) {
    const id = randomUUID();
    ids[key] = id;
    await db.insert(tagPlans).values({
      id, libraryId: opts.library ?? libraryId, name: key, scope, policy, status, createdBy: opts.library === otherLibraryId ? strangerId : ownerId,
      ...(opts.archived ? { archivedAt: new Date() } : {}),
    });
    await db.insert(tagPlanItems).values({
      tagPlanId: id, audioFileId: fileId,
      before: { album: 'Old title '.repeat(20) }, after: { album: 'New' }, diff: [{ field: 'album', before: 'Old', after: 'New', reason: 'policy:fill' }],
      status: opts.applied ? 'applied' : 'pending',
      ...(opts.applied ? { audioHashBefore: 'h', audioHashAfter: 'h' } : {}),
    });
  }

  const as = (user: string, role: string) => ({ 'x-test-user': user, 'x-test-role': role });
  // the cleanup covers every library (household), so other suites' finished plans in the
  // shared test database count too: the previews are checked against a baseline taken first
  const baseline: Record<'archived' | 'finished', TagChangeCleanupPreview> = {} as never;
  const preview = async (scope: 'archived' | 'finished') =>
    (await app.inject({ method: 'GET', url: `/api/v1/storage/tag-changes?scope=${scope}`, headers: as(ownerId, 'owner') })).json<TagChangeCleanupPreview>();
  const exists = async (key: string) => (await db.select({ id: tagPlans.id }).from(tagPlans).where(eq(tagPlans.id, ids[key]!))).length === 1;

  beforeAll(async () => {
    const { initDb } = await import('../db.js');
    const made = await initDb(process.env.TEST_DATABASE_URL!);
    db = made.db;
    client = made.client;
    cacheDir = await mkdtemp(join(tmpdir(), 'tagave-storage-'));
    await mkdir(join(cacheDir, 'art', 'ab'), { recursive: true });
    await writeFile(join(cacheDir, 'art', 'ab', 'cover.jpg'), Buffer.alloc(1000));
    await mkdir(join(cacheDir, 'backups'));
    await writeFile(join(cacheDir, 'backups', 'tagave.pgdump'), Buffer.alloc(300));

    await db.insert(users).values([
      { id: ownerId, email: `owner-${ownerId}@test.com`, passwordHash: 'x' },
      { id: strangerId, email: `stranger-${strangerId}@test.com`, passwordHash: 'x' },
    ]);
    await db.insert(libraries).values([
      { id: libraryId, name: 'Storage', ownerUserId: ownerId, settings: {} },
      { id: otherLibraryId, name: 'Other', ownerUserId: strangerId, settings: {} },
    ]);
    await db.insert(scanRoots).values({ id: rootId, libraryId, path: '/tmp/storage-root', displayName: 's', writable: true, validationStatus: 'ok' });
    await db.insert(files).values({ handler: 'audio', id: fileId, libraryId, scanRootId: rootId, relPath: 'A/01.flac', sizeBytes: 1, mtime: 1, status: 'present' });

    await setUp();
  });

  async function setUp() {
    const { errorHandler } = await import('../middleware/errorHandler.js');
    const { createStorageRoutes } = await import('./storage.js');
    app = Fastify({ logger: false });
    await errorHandler(app);
    app.addHook('preHandler', async (request) => {
      const id = request.headers['x-test-user'];
      request.user = typeof id === 'string' ? ({ id, email: `${id}@test.com`, role: request.headers['x-test-role'] } as any) : undefined;
    });
    await app.register(createStorageRoutes, { prefix: '/api/v1', cacheDir, backupDir: join(cacheDir, 'backups') });
    await app.ready();
    baseline.archived = await preview('archived');
    baseline.finished = await preview('finished');

    await plan('draft', 'draft', { archived: false });
    await plan('appliedArchived', 'applied', { archived: true, applied: true }); // revertible
    await plan('revertedArchived', 'reverted', { archived: true, applied: true }); // safe: old tags are back
    await plan('cancelledArchived', 'cancelled', { archived: true }); // safe: nothing written
    await plan('failedOpen', 'partially_failed'); // finished, not archived, nothing written
    await plan('appliedOpen', 'applied', { applied: true }); // finished, revertible, not archived
    // a library someone else created: shared in the household model, so the cleanup covers it too
    await plan('foreign', 'cancelled', { archived: true, library: otherLibraryId });
  }

  afterAll(async () => {
    await app?.close();
    const all = Object.values(ids);
    if (all.length) await db.delete(tagPlans).where(inArray(tagPlans.id, all));
    await db.delete(scanRoots).where(eq(scanRoots.id, rootId));
    await db.delete(libraries).where(inArray(libraries.id, [libraryId, otherLibraryId]));
    await db.delete(users).where(inArray(users.id, [ownerId, strangerId]));
    await rm(cacheDir, { recursive: true, force: true });
    await client?.end({ timeout: 5 });
  });

  it('is owner only', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/storage' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/v1/storage', headers: as(ownerId, 'viewer') })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/v1/storage/tag-changes', headers: as(ownerId, 'viewer') })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/v1/storage/tag-changes/cleanup', headers: as(ownerId, 'viewer'), payload: { scope: 'archived' } })).statusCode).toBe(403);
  });

  it('groups the database and sizes the folders, backups apart from the cache', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/storage', headers: as(ownerId, 'owner') });
    expect(res.statusCode).toBe(200);
    const body = res.json<StorageOverview>();
    expect(body.database.totalBytes).toBeGreaterThan(0);
    const keys = body.database.categories.map((c) => c.key);
    expect(keys).toEqual(['library', 'catalogue', 'artwork', 'providerCache', 'tagChanges', 'care', 'jobs', 'other']);
    const sum = body.database.categories.reduce((n, c) => n + c.bytes, 0);
    // the groups add up to the database total (the rest is under "everything else")
    expect(sum).toBeGreaterThanOrEqual(body.database.totalBytes * 0.95);
    const tagChanges = body.database.categories.find((c) => c.key === 'tagChanges')!;
    expect(tagChanges.tables.map((t) => t.name).sort()).toEqual(['tag_plan_items', 'tag_plans']);
    expect(tagChanges.bytes).toBeGreaterThan(0);
    const cache = body.folders.find((f) => f.key === 'cache')!;
    const backups = body.folders.find((f) => f.key === 'backups')!;
    expect(cache).toMatchObject({ exists: true, bytes: 1000, files: 1, truncated: false, error: null });
    expect(backups).toMatchObject({ exists: true, bytes: 300, files: 1 });
  });

  it('reports a missing folder without failing', async () => {
    const { folderUsage } = await import('../lib/storageUsage.js');
    expect(await folderUsage(join(cacheDir, 'nope'))).toMatchObject({ exists: false, bytes: 0, error: null });
    expect(await folderUsage(cacheDir, { maxEntries: 1 })).toMatchObject({ truncated: true });
  });

  it('previews archived plans: the revertible one counted apart', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/storage/tag-changes?scope=archived', headers: as(ownerId, 'owner') });
    expect(res.statusCode).toBe(200);
    const body = res.json<TagChangeCleanupPreview>();
    expect(body).toMatchObject({ scope: 'archived', plans: baseline.archived.plans + 3, revertible: { plans: baseline.archived.revertible.plans + 1 } });
    expect(body.bytes).toBeGreaterThan(0);
    expect(body.revertible.bytes).toBeGreaterThan(0);
    expect((await app.inject({ method: 'GET', url: '/api/v1/storage/tag-changes?scope=everything', headers: as(ownerId, 'owner') })).statusCode).toBe(400);
  });

  it('previews every finished plan, never drafts', async () => {
    const body = await preview('finished');
    expect(body).toMatchObject({ plans: baseline.finished.plans + 4, revertible: { plans: baseline.finished.revertible.plans + 2 } });
  });

  it('rejects a malformed cleanup request', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/storage/tag-changes/cleanup', headers: as(ownerId, 'owner'), payload: { scope: 'all' } });
    expect(res.statusCode).toBe(400);
  });

  it('deletes archived plans but keeps the one that can still be reverted', async () => {
    const before = await preview('archived');
    const res = await app.inject({ method: 'POST', url: '/api/v1/storage/tag-changes/cleanup', headers: as(ownerId, 'owner'), payload: { scope: 'archived' } });
    expect(res.statusCode).toBe(200);
    const body = res.json<TagChangeCleanupResult>();
    expect(body.deletedPlans).toBe(before.plans);
    expect(body.deletedPlans).toBeGreaterThanOrEqual(3);
    expect(body.freedBytes).toBeGreaterThan(0);
    expect(await exists('revertedArchived')).toBe(false);
    expect(await exists('cancelledArchived')).toBe(false);
    // household: a plan in a library another person created is cleaned up too
    expect(await exists('foreign')).toBe(false);
    expect(await exists('appliedArchived')).toBe(true);
    // items went with their plans
    const left = await db.select({ id: tagPlanItems.id }).from(tagPlanItems).where(inArray(tagPlanItems.tagPlanId, [ids['revertedArchived']!, ids['cancelledArchived']!]));
    expect(left).toHaveLength(0);
    // open plans and unarchived plans untouched
    expect(await exists('draft')).toBe(true);
    expect(await exists('failedOpen')).toBe(true);
  });

  it('deletes a revertible plan only when asked explicitly', async () => {
    const before = await preview('archived');
    const res = await app.inject({ method: 'POST', url: '/api/v1/storage/tag-changes/cleanup', headers: as(ownerId, 'owner'), payload: { scope: 'archived', includeRevertible: true } });
    expect(res.json<TagChangeCleanupResult>().deletedPlans).toBe(before.plans + before.revertible.plans);
    expect(await exists('appliedArchived')).toBe(false);
    expect(await exists('appliedOpen')).toBe(true);
  });

  it('finished scope takes the unarchived finished plans, still sparing the revertible', async () => {
    const before = await preview('finished');
    const res = await app.inject({ method: 'POST', url: '/api/v1/storage/tag-changes/cleanup', headers: as(ownerId, 'owner'), payload: { scope: 'finished' } });
    expect(res.json<TagChangeCleanupResult>().deletedPlans).toBe(before.plans);
    expect(await exists('failedOpen')).toBe(false);
    expect(await exists('appliedOpen')).toBe(true);
    expect(await exists('draft')).toBe(true);
  });
});
