/**
 * A Tag Plan waiting for its offline music folder (status 'waiting', its
 * apply job parked in parked_jobs): the owner can pause or cancel it, and
 * either one drops the parked job, so it never comes back on its own.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { eq, inArray } from 'drizzle-orm';
import { libraries, scanRoots, tagPlans, users } from '@tagave/db';

describe.skipIf(!process.env.TEST_DATABASE_URL)('a tag plan waiting for its music folder (route)', () => {
  let app: FastifyInstance;
  let db: any;
  let client: any;
  const ownerId = randomUUID();
  const libraryId = randomUUID();
  const rootId = randomUUID();
  const policy = { preset: 'manual', id3Version: '2.4', multiValueSeparator: '; ' };
  const planIds: string[] = [];

  async function waitingPlan(): Promise<string> {
    const id = randomUUID();
    planIds.push(id);
    await db.insert(tagPlans).values({ id, libraryId, name: 'Waiting plan', scope: { type: 'library' }, policy, status: 'waiting', createdBy: ownerId });
    await client`insert into parked_jobs (scan_root_id, queue, data, singleton_key, reason)
      values (${rootId}, 'tags.apply', ${JSON.stringify({ planId: id, waited: true })}::jsonb, ${`tags.apply:${id}`}, 'timeout')`;
    return id;
  }
  const post = (planId: string, action: 'pause' | 'cancel') =>
    app.inject({ method: 'POST', url: `/libraries/${libraryId}/tag-plans/${planId}/${action}`, headers: { 'x-test-user': ownerId } });
  const parked = async (planId: string) => client`select 1 from parked_jobs where singleton_key = ${`tags.apply:${planId}`}`;
  const status = async (planId: string) => (await db.select().from(tagPlans).where(eq(tagPlans.id, planId)))[0].status;

  beforeAll(async () => {
    const { initDb } = await import('../db.js');
    const made = await initDb(process.env.TEST_DATABASE_URL!);
    db = made.db;
    client = made.client;
    await db.insert(users).values({ id: ownerId, email: `robin-${ownerId}@example.com`, passwordHash: 'x' });
    await db.insert(libraries).values({ id: libraryId, name: 'Waiting', ownerUserId: ownerId, settings: {} });
    await db.insert(scanRoots).values({ id: rootId, libraryId, path: `/mnt/music/${rootId}`, displayName: 'Robin music' });
    const { errorHandler } = await import('../middleware/errorHandler.js');
    const { createTagPlansRoutes } = await import('./tagPlans.js');
    app = Fastify({ logger: false });
    await errorHandler(app);
    app.addHook('preHandler', async (request) => {
      const id = request.headers['x-test-user'];
      request.user = typeof id === 'string' ? ({ id, email: `${id}@example.com` } as any) : undefined;
    });
    await app.register(createTagPlansRoutes, { prefix: '/libraries/:libraryId' });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    if (planIds.length) await db.delete(tagPlans).where(inArray(tagPlans.id, planIds));
    await db.delete(libraries).where(eq(libraries.id, libraryId));
    await db.delete(users).where(eq(users.id, ownerId));
    await client?.end({ timeout: 5 });
  });

  it('pauses a waiting plan and drops its parked apply', async () => {
    const id = await waitingPlan();
    const res = await post(id, 'pause');
    expect(res.statusCode).toBe(200);
    expect(await status(id)).toBe('paused');
    expect(await parked(id)).toHaveLength(0);
  });

  it('cancels a waiting plan and drops its parked apply', async () => {
    const id = await waitingPlan();
    const res = await post(id, 'cancel');
    expect(res.statusCode).toBe(200);
    expect(await status(id)).toBe('cancelled');
    expect(await parked(id)).toHaveLength(0);
  });
});
