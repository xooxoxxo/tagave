/**
 * First-run and status endpoints: GET /auth/setup-required and
 * GET /system/checks, run against TEST_DATABASE_URL.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { eq, inArray } from 'drizzle-orm';
import { libraries, scanRoots, users } from '@liner/db';
import type { SessionUser } from '@liner/shared/auth';
import { initDb, getDb } from '../db.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { createAuthRoutes } from './auth.js';
import { createHealthRoutes } from './health.js';
import { createSystemRoutes, expectedWorkers } from './system.js';

describe('expectedWorkers', () => {
  it('defaults to one worker', () => {
    expect(expectedWorkers(undefined)).toBe(1);
    expect(expectedWorkers('')).toBe(1);
    expect(expectedWorkers('two')).toBe(1);
    expect(expectedWorkers('-1')).toBe(1);
    expect(expectedWorkers('1.5')).toBe(1);
  });

  it('reads a whole number, zero included', () => {
    expect(expectedWorkers('2')).toBe(2);
    expect(expectedWorkers('0')).toBe(0);
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)('first-run and system check routes (integration)', () => {
  let app: FastifyInstance;
  let as: SessionUser | undefined;
  const createdUsers: string[] = [];

  beforeAll(async () => {
    const databaseUrl = process.env.TEST_DATABASE_URL!;
    process.env.DATABASE_URL = databaseUrl;
    process.env.CACHE_DIR = path.join(os.tmpdir(), `liner-system-test-${process.pid}`);
    await initDb(databaseUrl);

    app = Fastify();
    await app.register(fastifyCookie);
    await errorHandler(app);
    app.addHook('preHandler', async (request) => {
      request.user = as;
    });
    await app.register(createAuthRoutes, { prefix: '/api/v1/auth' });
    await app.register(createHealthRoutes, { prefix: '/api/v1' });
    await app.register(createSystemRoutes, { prefix: '/api/v1' });
    await app.ready();
  });

  afterAll(async () => {
    for (const id of createdUsers) await getDb().delete(users).where(eq(users.id, id));
    await app?.close();
  });

  async function addUser(role: 'owner' | 'viewer'): Promise<SessionUser> {
    const id = randomUUID();
    const email = `system-test-${id}@test.com`;
    await getDb().insert(users).values({ id, email, displayName: 'System test', passwordHash: 'x', role, createdAt: new Date() });
    createdUsers.push(id);
    return { id, email, displayName: 'System test', role, createdAt: new Date().toISOString() };
  }

  it('setup-required answers from the users table without a session', async () => {
    as = undefined;
    const before = await getDb().select({ id: users.id }).from(users).limit(1);
    const first = await app.inject({ method: 'GET', url: '/api/v1/auth/setup-required' });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ setupRequired: before.length === 0 });

    await addUser('owner');
    const second = await app.inject({ method: 'GET', url: '/api/v1/auth/setup-required' });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ setupRequired: false });
  });

  it('system checks need a signed-in owner', async () => {
    as = undefined;
    const anonymous = await app.inject({ method: 'GET', url: '/api/v1/system/checks' });
    expect(anonymous.statusCode).toBe(401);

    as = await addUser('viewer');
    const viewer = await app.inject({ method: 'GET', url: '/api/v1/system/checks' });
    expect(viewer.statusCode).toBe(403);
  });

  it('system checks return every doctor check with a fix for each one that did not pass', async () => {
    as = await addUser('owner');
    const res = await app.inject({ method: 'GET', url: '/api/v1/system/checks' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      ok: boolean;
      checkedAt: string;
      checks: Array<{ id: string; title: string; status: string; detail: string; remediation: string | null }>;
    };
    expect(Number.isNaN(Date.parse(body.checkedAt))).toBe(false);
    const ids = body.checks.map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining(['database', 'migrations', 'workerHeartbeat', 'scanRoots', 'cacheDir']));
    expect(body.checks.find((c) => c.id === 'database')?.status).toBe('pass');
    // Local checks only: the page must not spend provider budget.
    expect(body.checks.find((c) => c.id === 'providers')?.status).toBe('skip');
    for (const c of body.checks) {
      if (c.status === 'pass' || c.status === 'skip') expect(c.remediation).toBeNull();
      else expect(c.remediation, c.id).toMatch(/\w+/);
    }
    expect(body.ok).toBe(body.checks.every((c) => c.status !== 'fail'));
  });

  it('scopes music folders to the library asked for, in plain words', async () => {
    const owner = await addUser('owner');
    const other = await addUser('owner');
    const mine = randomUUID();
    const theirs = randomUUID();
    await getDb().insert(libraries).values([
      { id: mine, name: 'Mine', ownerUserId: owner.id, settings: {} },
      { id: theirs, name: 'Theirs', ownerUserId: other.id, settings: {} },
    ]);
    try {
      await getDb().insert(scanRoots).values([
        { libraryId: mine, path: `/mine-${mine}`, displayName: 'mine', writable: false, validationStatus: 'ok', validatedAt: new Date() },
        { libraryId: theirs, path: `/theirs-${theirs}`, displayName: 'theirs', writable: false, validationStatus: 'pending' },
      ]);

      as = owner;
      const res = await app.inject({ method: 'GET', url: `/api/v1/system/checks?libraryId=${mine}` });
      expect(res.statusCode).toBe(200);
      const checks = (res.json() as { checks: Array<{ id: string; status: string; detail: string }> }).checks;
      const folders = checks.find((c) => c.id === 'scanRoots')!;
      expect(folders).toMatchObject({ status: 'pass', detail: '1 music folder OK' });
      for (const c of checks) {
        expect(c.detail, c.id).not.toMatch(/\(s\)|--offline|not mounted on this host/);
      }

      // someone else's library is not a scope this owner can ask for
      const foreign = await app.inject({ method: 'GET', url: `/api/v1/system/checks?libraryId=${theirs}` });
      expect(foreign.statusCode).toBe(404);

      // a malformed id is a bad request, not a database error
      for (const bad of ['not-a-uuid', '1234', `${mine}x`]) {
        const res400 = await app.inject({ method: 'GET', url: `/api/v1/system/checks?libraryId=${encodeURIComponent(bad)}` });
        expect(res400.statusCode, bad).toBe(400);
      }
    } finally {
      await getDb().delete(scanRoots).where(inArray(scanRoots.libraryId, [mine, theirs]));
      await getDb().delete(libraries).where(inArray(libraries.id, [mine, theirs]));
    }
  });

  it('the unauthenticated path probe and system/health are gone', async () => {
    as = undefined;
    const res = await app.inject({ method: 'POST', url: '/api/v1/system/test-path', payload: { path: '/etc' } });
    expect(res.statusCode).toBe(404);
    const health = await app.inject({ method: 'GET', url: '/api/v1/system/health' });
    expect(health.statusCode).toBe(404);
  });
});
