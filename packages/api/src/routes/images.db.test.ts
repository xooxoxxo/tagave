/**
 * GET /images/album/:albumId reads cover_thumbs (0046): the stored thumbnail
 * with its hash as ETag (304 on a match), a placeholder plus a rebuild
 * request when the album has a cover but no thumbnail (after a restore), and
 * 404 for an album without a cover. Since 0.9 the library is shared: any
 * signed-in user with catalog.read (the route table) sees every cover.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { eq, inArray } from 'drizzle-orm';
import { images, libraries, localAlbums, users } from '@tagave/db';

describe.skipIf(!process.env.TEST_DATABASE_URL)('cover thumbnail route (db)', () => {
  let app: FastifyInstance;
  let db: any;
  let client: any;
  const ownerId = randomUUID();
  const strangerId = randomUUID();
  const libraryId = randomUUID();
  const withThumb = randomUUID();
  const withoutThumb = randomUUID();
  const noCover = randomUUID();
  let missingImageId: string;
  const thumb = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
  const etag = `"${createHash('sha256').update(thumb).digest('hex')}"`;
  const requestRebuild = vi.fn(async (_imageId: string) => undefined);
  const as = (user: string) => ({ 'x-test-user': user });

  beforeAll(async () => {
    const { initDb } = await import('../db.js');
    const made = await initDb(process.env.TEST_DATABASE_URL!);
    db = made.db;
    client = made.client;
    await db.insert(users).values([
      { id: ownerId, email: `owner-${ownerId}@test.com`, passwordHash: 'x' },
      { id: strangerId, email: `stranger-${strangerId}@test.com`, passwordHash: 'x' },
    ]);
    await db.insert(libraries).values({ id: libraryId, name: 'Covers', ownerUserId: ownerId, settings: {} });
    for (const id of [withThumb, withoutThumb, noCover]) {
      await db.insert(localAlbums).values({ id, libraryId, clusterKey: `c:${id}`, dirPaths: [id], titleGuess: id });
    }
    const front = (id: string) => ({ libraryId, entityType: 'local_album', entityId: id, localAlbumId: id, kind: 'front', origin: 'owner', licenseNote: 'test' });
    const [a] = await db.insert(images).values(front(withThumb)).returning({ id: images.id });
    const [b] = await db.insert(images).values(front(withoutThumb)).returning({ id: images.id });
    missingImageId = b.id;
    await client`insert into cover_thumbs (image_id, bytes, sha256) values (${a.id}, ${thumb}, sha256(${thumb}::bytea))`;

    const { errorHandler } = await import('../middleware/errorHandler.js');
    const { createImageRoutes } = await import('./images.js');
    app = Fastify({ logger: false });
    await errorHandler(app);
    app.addHook('preHandler', async (request) => {
      const id = request.headers['x-test-user'];
      request.user = typeof id === 'string' ? ({ id, email: `${id}@test.com`, role: 'owner' } as any) : undefined;
    });
    await app.register(createImageRoutes, { prefix: '/api/v1', requestRebuild });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await db.delete(localAlbums).where(eq(localAlbums.libraryId, libraryId));
    await db.delete(libraries).where(eq(libraries.id, libraryId));
    await db.delete(users).where(inArray(users.id, [ownerId, strangerId]));
    await client?.end({ timeout: 5 });
  });

  it('serves the stored thumbnail with its hash as ETag, revalidated after a day', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/images/album/${withThumb}`, headers: as(ownerId) });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(res.headers['etag']).toBe(etag);
    expect(res.headers['cache-control']).toBe('private, max-age=86400');
    expect(res.rawPayload.equals(thumb)).toBe(true);
  });

  it('answers 304 when the browser already has that version', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/images/album/${withThumb}`, headers: { ...as(ownerId), 'if-none-match': etag } });
    expect(res.statusCode).toBe(304);
    expect(res.rawPayload.length).toBe(0);
    const stale = await app.inject({ method: 'GET', url: `/api/v1/images/album/${withThumb}`, headers: { ...as(ownerId), 'if-none-match': '"0000"' } });
    expect(stale.statusCode).toBe(200);
  });

  it('a cover without its thumbnail: the placeholder, never cached, and a rebuild request', async () => {
    requestRebuild.mockClear();
    const res = await app.inject({ method: 'GET', url: `/api/v1/images/album/${withoutThumb}`, headers: as(ownerId) });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^image\/svg\+xml/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['etag']).toBeUndefined();
    expect(res.payload).toMatch(/^<svg /);
    // 1×1 px: the web's CoverArt reads that as "being rebuilt" and retries
    expect(res.payload).toContain('width="1" height="1"');
    expect(res.headers['x-tagave-placeholder']).toBe('rebuilding');
    expect(requestRebuild).toHaveBeenCalledTimes(1);
    expect(requestRebuild).toHaveBeenCalledWith(missingImageId);
  });

  it('404 for an album without a cover, 401 signed out; no rebuild asked', async () => {
    requestRebuild.mockClear();
    expect((await app.inject({ method: 'GET', url: `/api/v1/images/album/${noCover}`, headers: as(ownerId) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/v1/images/album/${withThumb}` })).statusCode).toBe(401);
    expect(requestRebuild).not.toHaveBeenCalled();
  });

  it('another member of the install sees the same cover (the library is shared)', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/images/album/${withThumb}`, headers: as(strangerId) });
    expect(res.statusCode).toBe(200);
    expect(res.headers['etag']).toBe(etag);
  });

  it('the route stays in the permission table as catalog.read', async () => {
    const { ROUTE_PERMISSIONS } = await import('../permissions/routeTable.js');
    expect(ROUTE_PERMISSIONS['GET /api/v1/images/album/:albumId']).toBe('catalog.read');
  });

  it('claimSweepRequest: one sweep request per 30 minutes for the whole install', async () => {
    const { claimSweepRequest } = await import('../lib/thumbRebuild.js');
    await client`delete from cover_rebuild_log where kind = 'sweep'`;
    // a week-old row is pruned by the next claim
    await client`insert into cover_rebuild_log (kind, album_id, at) values ('refetch', gen_random_uuid(), now() - interval '8 days')`;
    const [a, b] = await Promise.all([claimSweepRequest(client), claimSweepRequest(client)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect((await client`select count(*)::int as n from cover_rebuild_log where at < now() - interval '7 days'`)[0].n).toBe(0);
    expect(await claimSweepRequest(client)).toBe(false);
    await client`update cover_rebuild_log set at = now() - interval '31 minutes' where kind = 'sweep'`;
    expect(await claimSweepRequest(client)).toBe(true);
    await client`delete from cover_rebuild_log where kind = 'sweep'`;
  });
});
