/**
 * Settings › Updates routes against TEST_DATABASE_URL, with the GitHub
 * Releases API stubbed: the feed is on by default, a check is one plain GET,
 * "skip this version" hides the badge, and turning checks off stops them.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { libraries, users } from '@liner/db';
import { DEFAULT_RELEASES_URL, type UpdatesStatus } from '@liner/shared';
import type { SessionUser } from '@liner/shared/auth';
import { initDb, getDb } from '../db.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { createUpdateRoutes } from './updates.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('update routes (integration)', () => {
  let app: FastifyInstance;
  const userId = randomUUID();
  const libraryId = randomUUID();
  const as: SessionUser = { id: userId, email: `updates-${userId}@test.com`, displayName: 'Updates', role: 'owner', createdAt: new Date().toISOString() };
  const base = `/api/v1/libraries/${libraryId}/updates`;
  const fetchMock = vi.fn();

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL!;
    delete process.env['TAGAVE_UPDATE_FEED'];
    await initDb(process.env.TEST_DATABASE_URL!);
    await getDb().insert(users).values({ id: userId, email: as.email, passwordHash: 'x' });
    await getDb().insert(libraries).values({ id: libraryId, name: 'Updates test', ownerUserId: userId });
    app = Fastify();
    await errorHandler(app);
    app.addHook('preHandler', async (request) => { request.user = as; });
    await app.register(createUpdateRoutes, { prefix: '/api/v1' });
    await app.ready();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => { fetchMock.mockReset(); });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await getDb().delete(libraries).where(eq(libraries.id, libraryId));
    await getDb().delete(users).where(eq(users.id, userId));
    await app?.close();
  });

  it('checks the official releases by default and sends nothing but a GET', async () => {
    const first = (await app.inject({ method: 'GET', url: base })).json() as UpdatesStatus;
    expect(first.feed).toMatchObject({ enabled: true, url: DEFAULT_RELEASES_URL, custom: false, lastCheckedAt: null });

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([
      { tag_name: 'v99.0.0', name: 'Big one', body: 'Requires attention: read the upgrade notes', prerelease: false, html_url: 'https://example.test/r' },
      { tag_name: 'v0.0.1', prerelease: false },
    ]), { status: 200, headers: { etag: '"abc"' } }));
    const res = await app.inject({ method: 'POST', url: `${base}/check` });
    expect(res.statusCode).toBe(200);
    const s = res.json() as UpdatesStatus;
    expect(s.updateAvailable).toBe(true);
    expect(s.feed.newer.map((r) => r.version)).toEqual(['99.0.0']);
    expect(s.feed.newer[0]!.requiresAttention).toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe(DEFAULT_RELEASES_URL);
    expect(init.method ?? 'GET').toBe('GET');
    expect(init.body).toBeUndefined();
    expect(init.headers).toEqual({ Accept: 'application/vnd.github+json', 'User-Agent': 'tagave-update-check' });
  });

  it('skip this version hides the update until a newer one appears', async () => {
    const skipped = (await app.inject({ method: 'PUT', url: `${base}/skip`, payload: { version: 'v99.0.0' } })).json() as UpdatesStatus;
    expect(skipped.feed.skippedVersion).toBe('99.0.0');
    expect(skipped.updateAvailable).toBe(false);
    const unskipped = (await app.inject({ method: 'PUT', url: `${base}/skip`, payload: { version: null } })).json() as UpdatesStatus;
    expect(unskipped.updateAvailable).toBe(true);
  });

  it('turning checks off hides releases and refuses a check', async () => {
    const off = (await app.inject({ method: 'PUT', url: `${base}/feed`, payload: { enabled: false } })).json() as UpdatesStatus;
    expect(off.feed.enabled).toBe(false);
    expect(off.updateAvailable).toBe(false);
    const check = await app.inject({ method: 'POST', url: `${base}/check` });
    expect(check.statusCode).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts only https feeds and returns to the official one on null', async () => {
    const bad = await app.inject({ method: 'PUT', url: `${base}/feed`, payload: { enabled: true, url: 'http://example.test/releases' } });
    expect(bad.statusCode).toBe(400);
    const custom = (await app.inject({ method: 'PUT', url: `${base}/feed`, payload: { enabled: true, url: 'https://api.github.com/repos/me/fork/releases' } })).json() as UpdatesStatus;
    expect(custom.feed).toMatchObject({ enabled: true, custom: true, url: 'https://api.github.com/repos/me/fork/releases', lastCheckedAt: null });
    const reset = (await app.inject({ method: 'PUT', url: `${base}/feed`, payload: { url: null } })).json() as UpdatesStatus;
    expect(reset.feed).toMatchObject({ custom: false, url: DEFAULT_RELEASES_URL });
  });
});
