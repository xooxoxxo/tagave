/**
 * The role matrix: every registered /api route, hit as anonymous, listener,
 * editor and owner (real Better Auth sessions on a scratch database), must
 * answer what its declared permission says: 401 for anonymous on anything
 * not public, 403 for a role without the permission, and through the guard
 * otherwise. A probe hook placed after the guard answers 299 for a request
 * that got through, so no handler runs and nothing is changed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import postgres from 'postgres';
import { can, type Role, type RoutePermission } from '@tagave/shared';
import type { AuthHandle } from '@tagave/auth';
import { registerApiRoutes } from '../app.js';
import { initAuth } from '../middleware/auth.js';
import { createScratchDb, migrateAll, testAuth } from '../testkit/authApp.js';
import { createTestUser } from '../testkit/users.js';
import { registeredRoutes, type RegisteredRoute } from '../testkit/routes.js';
import { declaredPermission, isGuarded, routeKey } from './guard.js';

const adminUrl = process.env.TEST_DATABASE_URL;
const PROBE = 'x-tagave-route-probe';
const ID = '00000000-0000-4000-8000-000000000001';

type Caller = 'anonymous' | Role;
const CALLERS: Caller[] = ['anonymous', 'listener', 'editor', 'owner'];

function expected(permission: RoutePermission, caller: Caller): number {
  if (permission === 'public') return 299;
  if (caller === 'anonymous') return 401;
  if (permission === 'self') return 299;
  return can(caller, permission) ? 299 : 403;
}

function concreteUrl(url: string): string {
  return url.replace(/:[A-Za-z]+/g, ID).replace(/\*$/, 'ok');
}

describe.skipIf(!adminUrl)('route permission matrix', () => {
  let admin: postgres.Sql;
  let db: { url: string; name: string };
  let handle: AuthHandle;
  let app: FastifyInstance;
  let routes: RegisteredRoute[];
  const cookies: Partial<Record<Caller, string>> = {};

  beforeAll(async () => {
    admin = postgres(adminUrl!, { max: 1, onnotice: () => undefined });
    db = await createScratchDb(adminUrl!, admin);
    await migrateAll(db.url);
    handle = testAuth(db.url);
    initAuth(handle);
    for (const role of ['listener', 'editor', 'owner'] as const) {
      cookies[role] = (await createTestUser(handle, { role })).cookie;
    }
    app = Fastify({ logger: false });
    await app.register(fastifyCookie);
    await registerApiRoutes(app, { backupService: { dir: '/nonexistent' } as never });
    // After the guard (registered inside registerApiRoutes): got this far = allowed.
    app.addHook('onRequest', async (request, reply) => {
      if (request.headers[PROBE] === '1') {
        await reply.status(299).send({ through: true });
        return reply;
      }
    });
    await app.ready();
    routes = (await registeredRoutes()).filter((r) => isGuarded(r.url) && !r.url.startsWith('/api/v1/docs'));
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await handle?.close();
    if (db) await admin.unsafe(`drop database if exists ${db.name} with (force)`).catch(() => undefined);
    await admin?.end({ timeout: 2 });
  });

  it('answers every route as its permission says, for every role', async () => {
    const wrong: string[] = [];
    const tally: Record<string, number> = {};
    for (const r of routes) {
      const permission = declaredPermission(r.method, r.url, r.config);
      expect(permission, routeKey(r.method, r.url)).toBeDefined();
      for (const caller of CALLERS) {
        const res = await app.inject({
          method: r.method as never,
          url: concreteUrl(r.url),
          headers: { [PROBE]: '1', origin: 'http://localhost:3100', ...(cookies[caller as Role] ? { cookie: cookies[caller as Role]! } : {}) },
        });
        const want = expected(permission!, caller);
        tally[`${caller} ${want}`] = (tally[`${caller} ${want}`] ?? 0) + 1;
        if (res.statusCode !== want) wrong.push(`${caller.padEnd(9)} ${routeKey(r.method, r.url)}: ${res.statusCode}, expected ${want}`);
      }
    }
    // Printed so the CI log shows the shape of the matrix.
    console.info(`route matrix: ${routes.length} routes x ${CALLERS.length} callers`, tally);
    expect(wrong).toEqual([]);
  }, 120_000);

  it('a listener is refused the owner and editor surfaces, for real', async () => {
    const listener = cookies.listener!;
    for (const [method, url] of [
      ['GET', '/api/v1/users'],
      ['GET', '/api/v1/backups'],
      ['GET', `/api/v1/libraries/${ID}/tag-plans`],
      ['POST', `/api/v1/libraries/${ID}/albums/bulk`],
      ['GET', `/api/v1/libraries/${ID}/queue`],
    ] as const) {
      const res = await app.inject({ method, url, headers: { cookie: listener, origin: 'http://localhost:3100' } });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(res.json()).toMatchObject({ title: 'Forbidden', detail: 'Not available for your account' });
    }
  });
});
