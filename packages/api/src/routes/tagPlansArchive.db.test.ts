/**
 * Archiving finished tag plans: POST /tag-plans/:id/archive and /unarchive,
 * and the list leaving archived plans out unless ?archived=true.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { eq, inArray } from 'drizzle-orm';
import { libraries, tagPlans, users } from '@tagave/db';

describe.skipIf(!process.env.TEST_DATABASE_URL)('tag plan archive (route)', () => {
  let app: FastifyInstance;
  let db: any;
  let client: any;
  const ownerId = randomUUID();
  const strangerId = randomUUID();
  const libraryId = randomUUID();
  const policy = { preset: 'canonical_ids_and_fill', id3Version: '2.4', multiValueSeparator: '; ' };
  const planIds: string[] = [];

  async function makePlan(status: string): Promise<string> {
    const id = randomUUID();
    planIds.push(id);
    await db.insert(tagPlans).values({ id, libraryId, name: `plan ${status}`, scope: { type: 'library' }, policy, status, createdBy: ownerId });
    return id;
  }
  const post = (planId: string, action: 'archive' | 'unarchive', as = ownerId) =>
    app.inject({ method: 'POST', url: `/libraries/${libraryId}/tag-plans/${planId}/${action}`, headers: { 'x-test-user': as } });
  const list = (query = '') =>
    app.inject({ method: 'GET', url: `/libraries/${libraryId}/tag-plans${query}`, headers: { 'x-test-user': ownerId } });

  beforeAll(async () => {
    const { initDb } = await import('../db.js');
    const made = await initDb(process.env.TEST_DATABASE_URL!);
    db = made.db;
    client = made.client;
    await db.insert(users).values([
      { id: ownerId, email: `owner-${ownerId}@test.com`, passwordHash: 'x' },
      { id: strangerId, email: `stranger-${strangerId}@test.com`, passwordHash: 'x' },
    ]);
    await db.insert(libraries).values({ id: libraryId, name: 'Archive', ownerUserId: ownerId, settings: {} });
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
    if (planIds.length) await db.delete(tagPlans).where(inArray(tagPlans.id, planIds));
    await db.delete(libraries).where(eq(libraries.id, libraryId));
    await db.delete(users).where(inArray(users.id, [ownerId, strangerId]));
    await client?.end({ timeout: 5 });
  });

  it.each(['applied', 'partially_failed', 'cancelled', 'reverted'])('archives a %s plan and hides it from the list', async (status) => {
    const id = await makePlan(status);
    const res = await post(id, 'archive');
    expect(res.statusCode).toBe(200);
    expect(res.json().archivedAt).toEqual(expect.any(String));
    const visible = (await list()).json();
    expect(visible.items.map((p: { id: string }) => p.id)).not.toContain(id);
    const archived = (await list('?archived=true')).json();
    const row = archived.items.find((p: { id: string }) => p.id === id);
    expect(row.archivedAt).toEqual(expect.any(String));
    expect(archived.archivedCount).toBe(archived.total);
    expect(visible.archivedCount).toBe(archived.total);
  });

  it.each(['draft', 'previewed', 'applying', 'paused'])('refuses to archive a %s plan', async (status) => {
    const id = await makePlan(status);
    expect((await post(id, 'archive')).statusCode).toBe(409);
    expect((await db.select().from(tagPlans).where(eq(tagPlans.id, id)))[0].archivedAt).toBeNull();
  });

  it('unarchives back into the list, and keeps the first archive time on a repeat', async () => {
    const id = await makePlan('applied');
    const first = (await post(id, 'archive')).json().archivedAt;
    const again = (await post(id, 'archive')).json().archivedAt;
    expect(again).toBe(first);
    const res = await post(id, 'unarchive');
    expect(res.statusCode).toBe(200);
    expect(res.json().archivedAt).toBeNull();
    expect((await list()).json().items.map((p: { id: string }) => p.id)).toContain(id);
  });

  it('is 404 for an unknown plan', async () => {
    const id = await makePlan('applied');
    expect((await post(randomUUID(), 'archive')).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/libraries/${libraryId}/tag-plans/${id}/archive` })).statusCode).toBe(401);
  });
});
