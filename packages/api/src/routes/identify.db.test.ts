/**
 * Library care › Identify through the real routes (fastify.inject, test
 * database): "Retry selected" queues the ticked albums, and "Identify now"
 * queues every waiting album, also the ones tried in the last hours.
 * pg-boss never runs: sends are recorded.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { libraries, localAlbums, users } from '@tagave/db';

const sent = vi.hoisted(() => [] as Array<{ name: string; data: any; opts: any }>);
vi.mock('../boss.js', () => ({
  getBoss: async () => ({
    send: async (name: string, data: unknown, opts: unknown) => {
      sent.push({ name, data, opts });
      return randomUUID();
    },
  }),
}));

describe.skipIf(!process.env.TEST_DATABASE_URL)('identify routes (db)', () => {
  let app: FastifyInstance;
  let db: any;
  let client: any;
  const ownerId = randomUUID();
  const libraryId = randomUUID();
  const otherLibraryId = randomUUID();
  const a1 = randomUUID();
  const a2 = randomUUID();
  const recent = randomUUID();
  const matched = randomUUID();
  const elsewhere = randomUUID();
  const as = { 'x-test-user': ownerId };
  const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url, headers: as, payload: payload as any });

  beforeAll(async () => {
    const { initDb } = await import('../db.js');
    const made = await initDb(process.env.TEST_DATABASE_URL!);
    db = made.db;
    client = made.client;
    await client`do $$ begin
      if not exists (select 1 from pg_namespace where nspname = 'pgboss') then create schema pgboss; end if;
    end $$`;
    await client`create table if not exists pgboss.job (
      id uuid, name text, state text, priority int, singleton_key text, data jsonb)`;
    await db.insert(users).values({ id: ownerId, email: `idr-${ownerId}@test.com`, passwordHash: 'x' });
    await db.insert(libraries).values([
      { id: libraryId, name: 'Identify', ownerUserId: ownerId, settings: {} },
      { id: otherLibraryId, name: 'Other', ownerUserId: ownerId, settings: {} },
    ]);
    const tried = new Date(Date.now() - 10 * 60_000);
    await db.insert(localAlbums).values([
      { id: a1, libraryId, clusterKey: `idr-${a1}`, dirPaths: ['A1'], titleGuess: 'One', artistGuess: 'X', state: 'unidentified', identifyReason: 'no_candidates' },
      { id: a2, libraryId, clusterKey: `idr-${a2}`, dirPaths: ['A2'], titleGuess: 'Two', artistGuess: 'X', state: 'pending' },
      // tried ten minutes ago: the five-minute sweep leaves it alone for hours
      { id: recent, libraryId, clusterKey: `idr-${recent}`, dirPaths: ['R'], titleGuess: 'Recent', artistGuess: 'X', state: 'pending', identifyAttempts: 1, lastIdentifyAt: tried, identifyReason: 'discogs_pass' },
      { id: matched, libraryId, clusterKey: `idr-${matched}`, dirPaths: ['M'], titleGuess: 'Done', artistGuess: 'X', state: 'matched' },
      { id: elsewhere, libraryId: otherLibraryId, clusterKey: `idr-${elsewhere}`, dirPaths: ['E'], titleGuess: 'Else', artistGuess: 'X', state: 'pending' },
    ]);

    const { errorHandler } = await import('../middleware/errorHandler.js');
    const { createIdentifyRoutes } = await import('./identify.js');
    app = Fastify({ logger: false });
    await errorHandler(app);
    app.addHook('preHandler', async (request) => {
      const id = request.headers['x-test-user'];
      request.user = typeof id === 'string' ? ({ id, email: `${id}@test.com` } as any) : undefined;
    });
    await app.register(createIdentifyRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await db.delete(localAlbums).where(eq(localAlbums.libraryId, libraryId));
    await db.delete(localAlbums).where(eq(localAlbums.libraryId, otherLibraryId));
    await db.delete(libraries).where(eq(libraries.id, libraryId));
    await db.delete(libraries).where(eq(libraries.id, otherLibraryId));
    await db.delete(users).where(eq(users.id, ownerId));
    await client?.end({ timeout: 5 });
  });

  beforeEach(() => { sent.length = 0; });

  describe('POST /identify/retry with albumIds', () => {
    it('queues the selected albums (several ids)', async () => {
      const res = await post(`/libraries/${libraryId}/identify/retry`, { albumIds: [a1, recent] });
      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ selected: 2, enqueued: 2 });
      expect(sent.map((s) => s.data.localAlbumId).sort()).toEqual([a1, recent].sort());
      expect(sent.every((s) => s.name === 'identify.album' && s.data.force === true)).toBe(true);
    });

    it('queues a single selected album', async () => {
      const res = await post(`/libraries/${libraryId}/identify/retry`, { albumIds: [a1] });
      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ selected: 1, enqueued: 1 });
    });

    it('ignores ids from another library and ids that are not uuids', async () => {
      const res = await post(`/libraries/${libraryId}/identify/retry`, { albumIds: [elsewhere, 'nope', a1] });
      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ selected: 1, enqueued: 1 });
      expect(sent.map((s) => s.data.localAlbumId)).toEqual([a1]);
    });

    it('says so when no id is usable', async () => {
      const res = await post(`/libraries/${libraryId}/identify/retry`, { albumIds: ['nope'] });
      expect(res.statusCode).toBe(400);
      expect(res.json().detail ?? res.json().message).toMatch(/album/i);
    });
  });

  describe('POST /identify/sweep (Identify now)', () => {
    it('queues every waiting album at once, including the ones tried a few minutes ago', async () => {
      const res = await post(`/libraries/${libraryId}/identify/sweep`, {});
      expect(res.statusCode).toBe(202);
      expect(res.json()).toMatchObject({ waiting: 2, enqueued: 2 });
      const albums = sent.filter((s) => s.name === 'identify.album').map((s) => s.data.localAlbumId).sort();
      expect(albums).toEqual([a2, recent].sort());
    });

    it('reports nothing to do when no album is waiting', async () => {
      const res = await post(`/libraries/${otherLibraryId}/identify/sweep`, {});
      expect(res.json()).toMatchObject({ waiting: 1 });
      await db.update(localAlbums).set({ state: 'unidentified' }).where(eq(localAlbums.id, elsewhere));
      sent.length = 0;
      const none = await post(`/libraries/${otherLibraryId}/identify/sweep`, {});
      expect(none.statusCode).toBe(202);
      expect(none.json()).toMatchObject({ waiting: 0, enqueued: 0 });
      expect(sent.filter((s) => s.name === 'identify.album')).toEqual([]);
    });
  });
});
