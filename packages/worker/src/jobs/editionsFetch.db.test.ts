/**
 * editions.fetch against a real database: the MusicBrainz browse is mocked at
 * the providers boundary, everything below it (page loop, cache, upserts, the
 * release-group stamp) runs for real.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, asc } from 'drizzle-orm';
import { libraries, users, releaseGroups, releases } from '@liner/db';
import { makeDb } from '@liner/db';
import pino from 'pino';
import type { Edition } from '@liner/core';
import type { WorkerContext } from '../lib/context.js';
import { editionsFetchJob } from './editionsFetch.js';

const { fetchPage } = vi.hoisted(() => ({ fetchPage: vi.fn() }));

vi.mock('../lib/providers.js', () => ({
  libraryProviderSettings: vi.fn(async () => ({ contactString: 'test@example.com' })),
  getProviders: vi.fn(() => ({ mb: { getReleaseGroupEditions: fetchPage } })),
  mbCall: vi.fn((_ctx: unknown, fn: () => Promise<unknown>) => fn()),
}));

const rgMeta = {
  mbid: '',
  title: 'Juggernaut: Omega',
  primaryType: 'Album',
  secondaryTypes: [] as string[],
  firstReleaseDate: '2015-01-23',
};

function edition(mbid: string, extra: Partial<Edition> = {}): Edition {
  return {
    mbid,
    title: 'Juggernaut: Omega',
    status: 'Official',
    date: '2015-01-23',
    country: 'XE',
    labels: [{ name: 'Century Media', catalogNumber: '9985320' }],
    media: [
      { position: 1, format: 'CD', trackCount: 7 },
      { position: 2, format: 'DVD-Video', trackCount: 2 },
    ],
    trackCount: 9,
    ...extra,
  };
}

function page(editions: Edition[], total: number, offset: number) {
  return { releaseGroup: { ...rgMeta }, editions, total, offset };
}

function httpError(status: number, message: string): Error {
  const err = new Error(message);
  (err as Error & { status?: number }).status = status;
  return err;
}

describe.skipIf(!process.env.TEST_DATABASE_URL)('editionsFetchJob (db)', () => {
  let ctx: WorkerContext;
  let db: any;
  let client: any;
  let userId: string;
  let libraryId: string;
  let rgId: string;
  let rgMbid: string;
  let ownedReleaseId: string;
  let ownedMbid: string;

  beforeAll(async () => {
    const databaseUrl = process.env.TEST_DATABASE_URL;
    if (!databaseUrl) {
      throw new Error('TEST_DATABASE_URL not set — these suites delete rows and must never run against DATABASE_URL');
    }
    const made = await makeDb(databaseUrl);
    db = made.db;
    client = made.client;
    ctx = { db: made.db, sql: made.client, boss: null as any, logger: pino({ level: 'silent' }) };

    userId = randomUUID();
    await db.insert(users).values({ id: userId, email: `test-${userId}@test.com`, passwordHash: 'x' });
    libraryId = randomUUID();
    await db.insert(libraries).values({ id: libraryId, name: 'Editions Library', ownerUserId: userId, settings: {} });
  });

  beforeEach(async () => {
    fetchPage.mockReset();
    // One release group with the single release identify already knew (the owned edition),
    // carrying stale descriptive columns the fetch must refresh in place.
    rgId = randomUUID();
    rgMbid = randomUUID();
    rgMeta.mbid = rgMbid;
    ownedMbid = randomUUID();
    await db.insert(releaseGroups).values({ id: rgId, mbid: rgMbid, title: 'Juggernaut: Omega', artistCredit: ['Periphery'] });
    ownedReleaseId = randomUUID();
    await db.insert(releases).values({
      id: ownedReleaseId, releaseGroupId: rgId, mbid: ownedMbid, title: 'Juggernaut: Omega',
      country: 'AU', trackCount: 9, media: [{ format: 'CD', position: 1 }], labels: [{ name: 'Roadrunner Records' }],
    });
  });

  afterAll(async () => {
    await client`delete from provider_cache where provider = 'musicbrainz' and cache_key like 'v2:rg-releases:%'`;
    await db.delete(releaseGroups).where(eq(releaseGroups.title, 'Juggernaut: Omega'));
    await db.delete(libraries).where(eq(libraries.id, libraryId));
    await db.delete(users).where(eq(users.id, userId));
    await client.end();
  });

  it('walks every page, upserts each edition, refreshes the owned one in place, and fills the release-group metadata', async () => {
    const a = randomUUID();
    const b = randomUUID();
    fetchPage
      .mockResolvedValueOnce(page([edition(a), edition(ownedMbid, { country: 'AU', labels: [{ name: 'Roadrunner Records', catalogNumber: '5419648592' }] })], 3, 0))
      .mockResolvedValueOnce(page([edition(b, { date: '2023-12-07', country: null, labels: [], media: [{ position: 1, format: 'CD', trackCount: 7 }], trackCount: 7 })], 3, 2));

    await editionsFetchJob(ctx, { releaseGroupId: rgId });

    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(fetchPage.mock.calls.map((c) => c[2])).toEqual([
      { offset: 0, limit: 100 },
      { offset: 2, limit: 100 },
    ]);

    const rows = await db.select().from(releases).where(eq(releases.releaseGroupId, rgId)).orderBy(asc(releases.mbid));
    expect(rows).toHaveLength(3);
    const byMbid = new Map<string, any>(rows.map((r: any) => [r.mbid, r]));

    const owned = byMbid.get(ownedMbid);
    expect(owned.id).toBe(ownedReleaseId); // updated in place, never re-created
    expect(owned.labels).toEqual([{ name: 'Roadrunner Records', catalogNumber: '5419648592' }]);
    expect(owned.media).toEqual([
      { position: 1, format: 'CD', trackCount: 7 },
      { position: 2, format: 'DVD-Video', trackCount: 2 },
    ]);
    expect(owned.trackCount).toBe(9);
    expect(owned.fetchedAt).toBeInstanceOf(Date);

    expect(byMbid.get(a).country).toBe('XE');
    expect(byMbid.get(a).barcode).toBeNull();
    expect(byMbid.get(b).country).toBeNull();
    expect(byMbid.get(b).labels).toEqual([]);
    expect(byMbid.get(b).trackCount).toBe(7);
    expect(String(byMbid.get(b).date)).toMatch(/^2023-12-07/);

    const rg = (await db.select().from(releaseGroups).where(eq(releaseGroups.id, rgId)))[0];
    expect(rg.editionsFetchedAt).toBeInstanceOf(Date);
    expect(rg.primaryType).toBe('Album');
    expect(String(rg.firstReleaseDate)).toMatch(/^2015-01-23/);

    const cached = await client`select cache_key from provider_cache where cache_key in (${'v2:rg-releases:' + rgMbid + ':0'}, ${'v2:rg-releases:' + rgMbid + ':2'}) order by cache_key`;
    expect(cached.map((r: any) => r.cache_key)).toEqual([`v2:rg-releases:${rgMbid}:0`, `v2:rg-releases:${rgMbid}:2`]);
  });

  it('serves a repeat run from the cache and bypasses it on force', async () => {
    const a = randomUUID();
    fetchPage.mockResolvedValue(page([edition(a)], 1, 0));

    await editionsFetchJob(ctx, { releaseGroupId: rgId });
    expect(fetchPage).toHaveBeenCalledTimes(1);

    // A second request inside the 30-day window is skipped outright; force re-runs and refetches.
    await editionsFetchJob(ctx, { releaseGroupId: rgId });
    expect(fetchPage).toHaveBeenCalledTimes(1);

    await editionsFetchJob(ctx, { releaseGroupId: rgId, force: true });
    expect(fetchPage).toHaveBeenCalledTimes(2);

    // Without force but with the stamp cleared, the page comes from provider_cache.
    await db.update(releaseGroups).set({ editionsFetchedAt: null }).where(eq(releaseGroups.id, rgId));
    await editionsFetchJob(ctx, { releaseGroupId: rgId });
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it('fails the job on a provider error instead of stamping the group as fetched', async () => {
    fetchPage.mockRejectedValue(httpError(400, 'Failed to fetch MusicBrainz release group x: Bad Request'));

    await expect(editionsFetchJob(ctx, { releaseGroupId: rgId, force: true })).rejects.toMatchObject({ status: 400 });

    const rg = (await db.select().from(releaseGroups).where(eq(releaseGroups.id, rgId)))[0];
    expect(rg.editionsFetchedAt).toBeNull();
    const rows = await db.select().from(releases).where(eq(releases.releaseGroupId, rgId));
    expect(rows).toHaveLength(1);
  });

  it('still lets a rate limit propagate for the retry path', async () => {
    fetchPage.mockRejectedValue(new Error('MusicBrainz rate limited (503): busy'));
    await expect(editionsFetchJob(ctx, { releaseGroupId: rgId })).rejects.toThrow(/503/);
    const rg = (await db.select().from(releaseGroups).where(eq(releaseGroups.id, rgId)))[0];
    expect(rg.editionsFetchedAt).toBeNull();
  });
});
