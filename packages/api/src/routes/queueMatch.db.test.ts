/**
 * Accepting a candidate (POST /albums/:albumId/match) fetches the cover at
 * once, as Fetch art does: the album stayed on "No cover art" until the
 * owner pressed it (QA 2026-10-26, Q-09).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { albumMatches, libraries, localAlbums, matchCandidates, releaseGroups, releases, users } from '@tagave/db';

const sent: Array<{ name: string; data: unknown; opts: { singletonKey?: string } | undefined }> = [];
vi.mock('../boss.js', () => ({
  getBoss: async () => ({
    createQueue: async () => undefined,
    send: async (name: string, data: unknown, opts?: { singletonKey?: string }) => { sent.push({ name, data, opts }); return 'job'; },
  }),
}));

describe.skipIf(!process.env.TEST_DATABASE_URL)('accepting a match (db)', () => {
  let app: FastifyInstance;
  let db: any;
  let client: any;
  const ownerId = randomUUID();
  const libraryId = randomUUID();
  const rgId = randomUUID();
  const releaseId = randomUUID();
  const albumId = randomUUID();
  const candidateId = randomUUID();

  beforeAll(async () => {
    const { initDb } = await import('../db.js');
    const made = await initDb(process.env.TEST_DATABASE_URL!);
    db = made.db;
    client = made.client;
    await db.insert(users).values({ id: ownerId, email: `accept-${ownerId}@test.com`, passwordHash: 'x' });
    await db.insert(libraries).values({ id: libraryId, name: 'Accept', ownerUserId: ownerId, settings: {} });
    await db.insert(releaseGroups).values({ id: rgId, mbid: randomUUID(), title: 'Windowlicker', artistCredit: ['Aphex Twin'] });
    await db.insert(releases).values({ id: releaseId, releaseGroupId: rgId, mbid: randomUUID(), title: 'Windowlicker', trackCount: 3, sourceOfTruth: 'musicbrainz' });
    await db.insert(localAlbums).values({ id: albumId, libraryId, clusterKey: `accept:${albumId}`, dirPaths: ['a/Windowlicker'], titleGuess: 'Windowlicker', state: 'needs_review', trackCount: 3 });
    await db.insert(matchCandidates).values({ id: candidateId, localAlbumId: albumId, releaseId, distance: '0.0500', breakdown: {}, source: 'mb_search' });

    const { errorHandler } = await import('../middleware/errorHandler.js');
    const { createQueueRoutes } = await import('./queue.js');
    app = Fastify({ logger: false });
    await errorHandler(app);
    app.addHook('preHandler', async (request) => {
      request.user = { id: ownerId, email: `${ownerId}@test.com` } as any;
    });
    await app.register(createQueueRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await db.delete(libraries).where(eq(libraries.id, libraryId));
    await db.delete(releases).where(eq(releases.id, releaseId));
    await db.delete(releaseGroups).where(eq(releaseGroups.id, rgId));
    await db.delete(users).where(eq(users.id, ownerId));
    await client.end({ timeout: 5 });
  });

  it('matches the album and queues its cover lookup with the Fetch art key', async () => {
    const res = await app.inject({ method: 'POST', url: `/albums/${albumId}/match`, payload: { candidateId } });
    expect(res.statusCode).toBe(200);
    const [row] = await db.select({ state: localAlbums.state, releaseId: localAlbums.releaseId }).from(localAlbums).where(eq(localAlbums.id, albumId));
    expect(row).toEqual({ state: 'matched', releaseId });
    expect(sent).toContainEqual({ name: 'art.fetch', data: { localAlbumId: albumId }, opts: { singletonKey: `art:${albumId}` } });
  });

  it('a hand accept is the person\'s, and the decision it replaced keeps its reason', async () => {
    const otherAlbum = randomUUID();
    const otherCandidate = randomUUID();
    await db.insert(localAlbums).values({ id: otherAlbum, libraryId, clusterKey: `accept:${otherAlbum}`, dirPaths: ['a/Windowlicker 2'], titleGuess: 'Windowlicker', state: 'matched', trackCount: 3, releaseId, releaseGroupId: rgId });
    await db.insert(albumMatches).values({ libraryId, localAlbumId: otherAlbum, releaseId, distance: '0.0300', status: 'auto', decidedBy: 'system', decidedKind: 'system', reason: 'auto-accept: distance 0.0300 (musicbrainz)' });
    await db.insert(matchCandidates).values({ id: otherCandidate, localAlbumId: otherAlbum, releaseId, distance: '0.0500', breakdown: {}, source: 'mb_search' });
    const res = await app.inject({ method: 'POST', url: `/albums/${otherAlbum}/match`, payload: { candidateId: otherCandidate } });
    expect(res.statusCode).toBe(200);
    const rows = await client`select status, reason, decided_kind, decided_by_user_id from album_matches where local_album_id = ${otherAlbum} order by created_at`;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ status: 'rejected', reason: 'auto-accept: distance 0.0300 (musicbrainz)' });
    expect(rows[1]).toMatchObject({ status: 'confirmed', decided_kind: 'user', decided_by_user_id: ownerId });
  });
});
