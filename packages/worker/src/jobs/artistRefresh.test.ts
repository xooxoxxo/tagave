/**
 * artist.refresh (XO-348) against a real database: the MusicBrainz browse is
 * mocked at the providers boundary, everything below it (cache, upserts,
 * credits, gap pass) runs for real.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, and, asc, inArray } from 'drizzle-orm';
import {
  artists,
  libraries,
  users,
  followedArtists,
  releaseGroups,
  releaseGroupArtists,
  gaps,
} from '@liner/db';
import { makeDb } from '@liner/db';
import pino from 'pino';
import type { WorkerContext } from '../lib/context.js';
import { artistRefreshJob } from './artistRefresh.js';

const { browse } = vi.hoisted(() => ({ browse: vi.fn() }));

vi.mock('../lib/providers.js', () => ({
  libraryProviderSettings: vi.fn(async () => ({ contactString: 'test@example.com' })),
  getProviders: vi.fn(() => ({ mb: { browseArtistReleaseGroups: browse } })),
  mbCall: vi.fn((_ctx: unknown, fn: () => Promise<unknown>) => fn()),
}));

type Rg = {
  mbid: string;
  title: string;
  primaryType: string | null;
  secondaryTypes: string[];
  firstReleaseDate: string | null;
  artistCredits: Array<{ mbid?: string; name: string; joinPhrase?: string }>;
};

function page(items: Rg[], total: number, offset: number) {
  return { items, total, offset };
}

describe.skipIf(!process.env.TEST_DATABASE_URL)('artistRefreshJob', () => {
  let ctx: WorkerContext;
  let db: any;
  let client: any;
  let userId: string;
  let libraryId: string;
  let artistId: string;
  let artistMbid: string;
  let partnerId: string;
  let partnerMbid: string;
  const rgMbids: string[] = [];
  const artistIds: string[] = [];
  const artistMbids: string[] = [];

  const rg1 = randomUUID(); // solo album
  const rg2 = randomUUID(); // live album → excluded by the default secondary rule
  const rg3 = randomUUID(); // collaboration, partner credited first
  const rg4 = randomUUID(); // single → outside includePrimary
  const rg5 = randomUUID(); // EP

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
    await db.insert(libraries).values({ id: libraryId, name: 'Refresh Library', ownerUserId: userId, settings: {} });

    artistId = randomUUID();
    artistMbid = randomUUID();
    partnerId = randomUUID();
    partnerMbid = randomUUID();
    artistIds.push(artistId, partnerId);
    artistMbids.push(artistMbid, partnerMbid);
    await db.insert(artists).values([
      { id: artistId, mbid: artistMbid, name: 'Followed Artist' },
      { id: partnerId, mbid: partnerMbid, name: 'Partner' },
    ]);

    // Albums and EPs, live records excluded (the library default).
    await db.insert(followedArtists).values({
      libraryId,
      artistId,
      mode: 'manual',
      includePrimary: ['Album', 'EP'],
      excludeSecondary: ['Live', 'Compilation'],
    });

    // The collaboration already exists with the partner at position 0 — the
    // shape that broke the first implementation (PK is release_group_id, position).
    const [existing] = await db.insert(releaseGroups)
      .values({ mbid: rg3, title: 'Collab (stale title)', primaryType: 'Album' })
      .returning({ id: releaseGroups.id });
    await db.insert(releaseGroupArtists).values({ releaseGroupId: existing.id, artistId: partnerId, position: 0, creditedName: 'Partner' });
    rgMbids.push(rg1, rg2, rg3, rg4, rg5);
  });

  beforeEach(() => {
    browse.mockReset();
    browse.mockImplementation(async (_mbid: string, _ctx: unknown, opts: { offset?: number }) => page([
      { mbid: rg1, title: 'Solo Album', primaryType: 'Album', secondaryTypes: [], firstReleaseDate: '2001', artistCredits: [{ mbid: artistMbid, name: 'Followed Artist' }] },
      { mbid: rg2, title: 'Live at the Test', primaryType: 'Album', secondaryTypes: ['Live'], firstReleaseDate: '2002-05', artistCredits: [{ mbid: artistMbid, name: 'Followed Artist' }] },
      { mbid: rg3, title: 'Collab', primaryType: 'Album', secondaryTypes: [], firstReleaseDate: '2003-03-03', artistCredits: [{ mbid: partnerMbid, name: 'Partner', joinPhrase: ' & ' }, { mbid: artistMbid, name: 'Followed Artist' }] },
      { mbid: rg4, title: 'A Single', primaryType: 'Single', secondaryTypes: [], firstReleaseDate: null, artistCredits: [{ mbid: artistMbid, name: 'Followed Artist' }] },
      { mbid: rg5, title: 'The EP', primaryType: 'EP', secondaryTypes: [], firstReleaseDate: '2004', artistCredits: [{ mbid: artistMbid, name: 'Followed Artist' }] },
    ], 5, opts.offset ?? 0));
  });

  afterAll(async () => {
    await db.delete(gaps).where(eq(gaps.libraryId, libraryId));
    if (artistIds.length) await db.delete(releaseGroupArtists).where(inArray(releaseGroupArtists.artistId, artistIds));
    if (rgMbids.length) await db.delete(releaseGroups).where(inArray(releaseGroups.mbid, rgMbids));
    await db.delete(followedArtists).where(eq(followedArtists.libraryId, libraryId));
    if (artistIds.length) await db.delete(artists).where(inArray(artists.id, artistIds));
    for (const mbid of artistMbids) {
      await client`delete from provider_cache where cache_key like ${'%:' + mbid + ':%'}`;
    }
    await db.delete(libraries).where(eq(libraries.id, libraryId));
    await db.delete(users).where(eq(users.id, userId));
    await client.end({ timeout: 5 });
  });

  async function linksOf(mbid: string) {
    const [rg] = await db.select().from(releaseGroups).where(eq(releaseGroups.mbid, mbid));
    if (!rg) return null;
    const rows = await db.select().from(releaseGroupArtists)
      .where(eq(releaseGroupArtists.releaseGroupId, rg.id))
      .orderBy(asc(releaseGroupArtists.position));
    return rows.map((r: any) => ({ artistId: r.artistId, position: r.position, creditedName: r.creditedName, joinPhrase: r.joinPhrase }));
  }

  async function openGaps() {
    const rows = await db.select().from(gaps)
      .where(and(eq(gaps.libraryId, libraryId), eq(gaps.kind, 'missing_album'), eq(gaps.state, 'open')));
    const byMbid = new Map<string, any>();
    for (const g of rows) {
      const [rg] = await db.select().from(releaseGroups).where(eq(releaseGroups.id, g.subjectId));
      byMbid.set(rg.mbid, g);
    }
    return byMbid;
  }

  it('one browse page → groups, credits, gaps and last_refreshed_at', async () => {
    await artistRefreshJob(ctx, { libraryId, artistId });

    expect(browse).toHaveBeenCalledTimes(1);
    expect(browse.mock.calls[0]![0]).toBe(artistMbid);
    expect(browse.mock.calls[0]![2]).toEqual({ types: ['Album', 'EP'], offset: 0, limit: 100 });

    // Albums and EPs persisted (live too — the gap pass applies excludeSecondary), the single not.
    const stored = await db.select().from(releaseGroups).where(inArray(releaseGroups.mbid, [rg1, rg2, rg3, rg4, rg5]));
    expect(stored.map((r: any) => r.mbid).sort()).toEqual([rg1, rg2, rg3, rg5].sort());
    const solo = stored.find((r: any) => r.mbid === rg1);
    expect(solo).toMatchObject({ title: 'Solo Album', primaryType: 'Album', secondaryTypes: [], firstReleaseDate: '2001-01-01', artistCredit: ['Followed Artist'] });
    const collab = stored.find((r: any) => r.mbid === rg3);
    expect(collab).toMatchObject({ title: 'Collab', firstReleaseDate: '2003-03-03', artistCredit: ['Partner', 'Followed Artist'] });
    const live = stored.find((r: any) => r.mbid === rg2);
    expect(live).toMatchObject({ secondaryTypes: ['Live'], firstReleaseDate: '2002-05-01' });

    // Full MB credit per group: the partner keeps position 0, the followed artist lands at 1.
    expect(await linksOf(rg3)).toEqual([
      { artistId: partnerId, position: 0, creditedName: 'Partner', joinPhrase: ' & ' },
      { artistId, position: 1, creditedName: 'Followed Artist', joinPhrase: null },
    ]);
    expect(await linksOf(rg1)).toEqual([{ artistId, position: 0, creditedName: 'Followed Artist', joinPhrase: null }]);

    // Gaps follow the rules: live excluded, single never fetched.
    const open = await openGaps();
    expect([...open.keys()].sort()).toEqual([rg1, rg3, rg5].sort());
    expect(open.get(rg5).details).toEqual({ title: 'The EP', primaryType: 'EP' });

    const [follow] = await db.select().from(followedArtists)
      .where(and(eq(followedArtists.libraryId, libraryId), eq(followedArtists.artistId, artistId)));
    expect(follow.lastRefreshedAt).not.toBeNull();
  });

  it('a second run is served from the browse cache and changes nothing; force refetches', async () => {
    await artistRefreshJob(ctx, { libraryId, artistId });
    expect(browse).toHaveBeenCalledTimes(0);
    expect(await linksOf(rg3)).toHaveLength(2);
    expect([...(await openGaps()).keys()].sort()).toEqual([rg1, rg3, rg5].sort());

    await artistRefreshJob(ctx, { libraryId, artistId, force: true });
    expect(browse).toHaveBeenCalledTimes(1);
    expect(await linksOf(rg3)).toHaveLength(2);
  });

  it('a tightened rule resolves gaps on the next refresh without refetching', async () => {
    await db.update(followedArtists).set({ includePrimary: ['Album'] })
      .where(and(eq(followedArtists.libraryId, libraryId), eq(followedArtists.artistId, artistId)));

    await artistRefreshJob(ctx, { libraryId, artistId });

    const open = await openGaps();
    expect(open.has(rg5)).toBe(false);
    expect([...open.keys()].sort()).toEqual([rg1, rg3].sort());
    const [epGap] = await db.select().from(gaps).where(and(eq(gaps.libraryId, libraryId), eq(gaps.kind, 'missing_album'), eq(gaps.state, 'resolved')));
    expect(epGap).toBeDefined();

    await db.update(followedArtists).set({ includePrimary: ['Album', 'EP'] })
      .where(and(eq(followedArtists.libraryId, libraryId), eq(followedArtists.artistId, artistId)));
  });

  it('walks browse pages until the reported total is reached', async () => {
    const prolificId = randomUUID();
    const prolificMbid = randomUUID();
    artistIds.push(prolificId);
    artistMbids.push(prolificMbid);
    await db.insert(artists).values({ id: prolificId, mbid: prolificMbid, name: 'Prolific' });
    await db.insert(followedArtists).values({ libraryId, artistId: prolificId, mode: 'manual', includePrimary: ['Album'] });

    const all: Rg[] = Array.from({ length: 150 }, (_, i) => {
      const mbid = randomUUID();
      rgMbids.push(mbid);
      return { mbid, title: `Album ${i}`, primaryType: 'Album', secondaryTypes: [], firstReleaseDate: `${1950 + i}`, artistCredits: [{ mbid: prolificMbid, name: 'Prolific' }] };
    });
    browse.mockImplementation(async (_mbid: string, _ctx: unknown, opts: { offset?: number; limit?: number }) => {
      const offset = opts.offset ?? 0;
      return page(all.slice(offset, offset + (opts.limit ?? 100)), all.length, offset);
    });

    await artistRefreshJob(ctx, { libraryId, artistId: prolificId });

    expect(browse).toHaveBeenCalledTimes(2);
    expect(browse.mock.calls.map((c) => c[2].offset)).toEqual([0, 100]);
    const stored = await db.select().from(releaseGroups).where(inArray(releaseGroups.mbid, all.map((r) => r.mbid)));
    expect(stored).toHaveLength(150);
    const links = await db.select().from(releaseGroupArtists).where(eq(releaseGroupArtists.artistId, prolificId));
    expect(links).toHaveLength(150);
    const open = await db.select().from(gaps).where(and(eq(gaps.libraryId, libraryId), eq(gaps.kind, 'missing_album'), eq(gaps.state, 'open')));
    expect(open.length).toBeGreaterThanOrEqual(150);
  });

  it('does nothing for an unknown or unfollowed artist', async () => {
    await artistRefreshJob(ctx, { libraryId, artistId: randomUUID() });
    await artistRefreshJob(ctx, { libraryId, artistId: partnerId });
    expect(browse).not.toHaveBeenCalled();
  });

  it('a 404 from MusicBrainz counts the run and does not throw', async () => {
    const goneId = randomUUID();
    const goneMbid = randomUUID();
    artistIds.push(goneId);
    artistMbids.push(goneMbid);
    await db.insert(artists).values({ id: goneId, mbid: goneMbid, name: 'Gone' });
    await db.insert(followedArtists).values({ libraryId, artistId: goneId, mode: 'manual' });
    browse.mockImplementation(async () => {
      const err = new Error('Failed to browse MusicBrainz release groups for artist x: Not Found');
      (err as Error & { status?: number }).status = 404;
      throw err;
    });

    await expect(artistRefreshJob(ctx, { libraryId, artistId: goneId })).resolves.toBeUndefined();
    const [follow] = await db.select().from(followedArtists)
      .where(and(eq(followedArtists.libraryId, libraryId), eq(followedArtists.artistId, goneId)));
    expect(follow.lastRefreshedAt).not.toBeNull();
  });

  it('a rate-limit error is rethrown so pg-boss retries after the cooldown', async () => {
    const limitedId = randomUUID();
    const limitedMbid = randomUUID();
    artistIds.push(limitedId);
    artistMbids.push(limitedMbid);
    await db.insert(artists).values({ id: limitedId, mbid: limitedMbid, name: 'Limited' });
    await db.insert(followedArtists).values({ libraryId, artistId: limitedId, mode: 'manual' });
    browse.mockImplementation(async () => {
      throw new Error('MusicBrainz rate limited (503): server busy');
    });

    await expect(artistRefreshJob(ctx, { libraryId, artistId: limitedId })).rejects.toThrow(/rate limited/);
    const [follow] = await db.select().from(followedArtists)
      .where(and(eq(followedArtists.libraryId, libraryId), eq(followedArtists.artistId, limitedId)));
    expect(follow.lastRefreshedAt).toBeNull();
  });
});
