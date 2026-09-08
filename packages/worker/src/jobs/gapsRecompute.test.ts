/**
 * Tests for gaps.recompute job handler - specifically GAP-2 missing_album gaps
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import {
  users,
  libraries,
  artists,
  releaseGroups,
  releaseGroupArtists,
  localAlbums,
  followedArtists,
  gaps,
} from '@liner/db';
import { makeDb } from '@liner/db';
import type { WorkerContext } from '../lib/context.js';
import { gapsRecomputeJob, type GapsRecomputeJobData } from './gapsRecompute.js';
import pino from 'pino';

const hasDatabaseUrl = !!(process.env.TEST_DATABASE_URL);

describe.skipIf(!hasDatabaseUrl)('gapsRecomputeJob - missing_album gaps', () => {
  let ctx: WorkerContext;
  let db: any;
  let userId: string;
  let libraryId: string;
  let artistId: string;
  let releaseGroupId1: string;
  let releaseGroupId2: string;
  let releaseGroupId3: string;

  beforeAll(async () => {
    const databaseUrl = process.env.TEST_DATABASE_URL;
    if (!databaseUrl) {
      throw new Error('TEST_DATABASE_URL not set — these suites delete rows and must never run against DATABASE_URL');
    }

    const { db: dbInstance, client } = await makeDb(databaseUrl);
    db = dbInstance;
    ctx = {
      db: dbInstance,
      sql: client,
      boss: null as any,
      logger: pino({ level: 'silent' }),
    };

    // Create test user
    userId = randomUUID();
    await db.insert(users).values({
      id: userId,
      email: `test-${userId}@test.com`,
      passwordHash: 'test-hash',
      createdAt: new Date(),
    });

    // Create test library
    libraryId = randomUUID();
    await db.insert(libraries).values({
      id: libraryId,
      name: 'Test Library',
      ownerUserId: userId,
      createdAt: new Date(),
    });

    // Create test artist
    artistId = randomUUID();
    await db.insert(artists).values({
      id: artistId,
      mbid: randomUUID(),
      name: 'Test Artist',
      createdAt: new Date(),
    });

    // Create release groups
    releaseGroupId1 = randomUUID();
    releaseGroupId2 = randomUUID();
    releaseGroupId3 = randomUUID();

    await db.insert(releaseGroups).values([
      {
        id: releaseGroupId1,
        mbid: randomUUID(),
        title: 'Album One',
        primaryType: 'Album',
      },
      {
        id: releaseGroupId2,
        mbid: randomUUID(),
        title: 'Album Two',
        primaryType: 'Album',
      },
      {
        id: releaseGroupId3,
        mbid: randomUUID(),
        title: 'Album Three',
        primaryType: 'EP',
      },
    ]);

    // Link artist to release groups
    await db.insert(releaseGroupArtists).values([
      {
        releaseGroupId: releaseGroupId1,
        artistId,
        position: 0,
      },
      {
        releaseGroupId: releaseGroupId2,
        artistId,
        position: 0,
      },
      {
        releaseGroupId: releaseGroupId3,
        artistId,
        position: 0,
      },
    ]);

    // Follow the artist; the fixtures are two albums and an EP, so the
    // per-artist rules must include EPs (the schema default is Album only).
    await db.insert(followedArtists).values({
      libraryId,
      artistId,
      mode: 'manual',
      includePrimary: ['Album', 'EP'],
      createdAt: new Date(),
    });
  });

  afterAll(async () => {
    // Cleanup
    await db.delete(gaps).where(eq(gaps.libraryId, libraryId));
    await db.delete(localAlbums).where(eq(localAlbums.libraryId, libraryId));
    await db.delete(releaseGroupArtists).where(eq(releaseGroupArtists.artistId, artistId));
    await db.delete(releaseGroups);
    await db.delete(followedArtists).where(eq(followedArtists.libraryId, libraryId));
    await db.delete(artists).where(eq(artists.id, artistId));
    await db.delete(libraries).where(eq(libraries.id, libraryId));
    await db.delete(users).where(eq(users.id, userId));
  });

  it('should create missing_album gaps for release groups not owned locally', async () => {
    // Initially, no local albums exist, so all 3 release groups should get missing_album gaps
    const data: GapsRecomputeJobData = { libraryId };
    await gapsRecomputeJob(ctx, data);

    const missingGaps = await db
      .select()
      .from(gaps)
      .where(
        and(
          eq(gaps.libraryId, libraryId),
          eq(gaps.kind, 'missing_album'),
          eq(gaps.state, 'open')
        )
      );

    expect(missingGaps).toHaveLength(3);

    // Verify details contain title and primaryType
    const gap1 = missingGaps.find((g: any) => g.subjectId === releaseGroupId1);
    expect(gap1).toBeDefined();
    expect(gap1?.details).toEqual({ title: 'Album One', primaryType: 'Album' });

    const gap2 = missingGaps.find((g: any) => g.subjectId === releaseGroupId2);
    expect(gap2).toBeDefined();
    expect(gap2?.details).toEqual({ title: 'Album Two', primaryType: 'Album' });

    const gap3 = missingGaps.find((g: any) => g.subjectId === releaseGroupId3);
    expect(gap3).toBeDefined();
    expect(gap3?.details).toEqual({ title: 'Album Three', primaryType: 'EP' });
  });

  it('should persist dismissed gaps across recompute cycles', async () => {
    // First recompute to create gaps
    let data: GapsRecomputeJobData = { libraryId };
    await gapsRecomputeJob(ctx, data);

    // Dismiss one gap
    await db
      .update(gaps)
      .set({
        state: 'dismissed',
        dismissReason: 'wrong_data',
      })
      .where(eq(gaps.subjectId, releaseGroupId1));

    // Run recompute again
    await gapsRecomputeJob(ctx, data);

    // The dismissed gap should still be dismissed
    const dismissedGap = await db
      .select()
      .from(gaps)
      .where(
        and(
          eq(gaps.libraryId, libraryId),
          eq(gaps.subjectId, releaseGroupId1),
          eq(gaps.kind, 'missing_album')
        )
      )
      .limit(1);

    expect(dismissedGap[0]).toBeDefined();
    expect(dismissedGap[0]?.state).toBe('dismissed');
    expect(dismissedGap[0]?.dismissReason).toBe('wrong_data');
  });

  it('should transition gaps to resolved when release group becomes owned', async () => {
    // First recompute to create gaps
    let data: GapsRecomputeJobData = { libraryId };
    await gapsRecomputeJob(ctx, data);

    // Create a local album for releaseGroupId1
    const localAlbumId = randomUUID();
    await db.insert(localAlbums).values({
      id: localAlbumId,
      libraryId,
      clusterKey: 'test-cluster-1',
      state: 'matched',
      releaseGroupId: releaseGroupId1,
      trackCount: 10,
      discCount: 1,
      createdAt: new Date(),
    });

    // Run recompute again
    await gapsRecomputeJob(ctx, data);

    // The gap for releaseGroupId1 should be resolved
    const resolvedGap = await db
      .select()
      .from(gaps)
      .where(
        and(
          eq(gaps.libraryId, libraryId),
          eq(gaps.subjectId, releaseGroupId1),
          eq(gaps.kind, 'missing_album')
        )
      )
      .limit(1);

    expect(resolvedGap[0]).toBeDefined();
    expect(resolvedGap[0]?.state).toBe('resolved');
    expect(resolvedGap[0]?.resolvedAt).toBeDefined();

    // The other gaps should still be open
    const openGaps = await db
      .select()
      .from(gaps)
      .where(
        and(
          eq(gaps.libraryId, libraryId),
          eq(gaps.kind, 'missing_album'),
          eq(gaps.state, 'open')
        )
      );

    expect(openGaps).toHaveLength(2);
  });

  it('should use natural key upsert to prevent duplicate gaps', async () => {
    // Run recompute twice without changes
    const data: GapsRecomputeJobData = { libraryId };

    // Clear existing gaps first
    await db.delete(gaps).where(eq(gaps.libraryId, libraryId));

    await gapsRecomputeJob(ctx, data);
    const countAfterFirst = await db
      .select()
      .from(gaps)
      .where(
        and(
          eq(gaps.libraryId, libraryId),
          eq(gaps.kind, 'missing_album')
        )
      );

    await gapsRecomputeJob(ctx, data);
    const countAfterSecond = await db
      .select()
      .from(gaps)
      .where(
        and(
          eq(gaps.libraryId, libraryId),
          eq(gaps.kind, 'missing_album')
        )
      );

    // Same number of gaps - no duplicates
    expect(countAfterFirst).toHaveLength(2); // releaseGroupId2 and Id3, since Id1 is owned
    expect(countAfterSecond).toHaveLength(2);
  });

  it('should handle mark-and-sweep pattern correctly', async () => {
    // Clear all gaps
    await db.delete(gaps).where(eq(gaps.libraryId, libraryId));

    // First run: create gaps for all unowned release groups
    let data: GapsRecomputeJobData = { libraryId };
    await gapsRecomputeJob(ctx, data);

    let allGaps = await db
      .select()
      .from(gaps)
      .where(
        and(
          eq(gaps.libraryId, libraryId),
          eq(gaps.kind, 'missing_album')
        )
      );
    expect(allGaps).toHaveLength(2); // releaseGroupId2 and Id3, since Id1 is owned

    // Add ownership for releaseGroupId2
    const localAlbumId2 = randomUUID();
    await db.insert(localAlbums).values({
      id: localAlbumId2,
      libraryId,
      clusterKey: 'test-cluster-2',
      state: 'matched',
      releaseGroupId: releaseGroupId2,
      trackCount: 12,
      discCount: 1,
      createdAt: new Date(),
    });

    // Run recompute - should resolve the gap for releaseGroupId2
    await gapsRecomputeJob(ctx, data);

    allGaps = await db
      .select()
      .from(gaps)
      .where(
        and(
          eq(gaps.libraryId, libraryId),
          eq(gaps.kind, 'missing_album')
        )
      );

    // Should have one resolved and one open
    const resolved = allGaps.filter((g: any) => g.state === 'resolved');
    const open = allGaps.filter((g: any) => g.state === 'open');

    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.subjectId).toBe(releaseGroupId2);
    expect(open).toHaveLength(1);
    expect(open[0]?.subjectId).toBe(releaseGroupId3);
  });

  it('should correctly identify release groups through release_group_artists', async () => {
    // Create a new artist and release group
    const newArtistId = randomUUID();
    const newRgId = randomUUID();

    await db.insert(artists).values({
      id: newArtistId,
      mbid: randomUUID(),
      name: 'Another Artist',
      createdAt: new Date(),
    });

    await db.insert(releaseGroups).values({
      id: newRgId,
      mbid: randomUUID(),
      title: 'Another Album',
      primaryType: 'Single',
    });

    await db.insert(releaseGroupArtists).values({
      releaseGroupId: newRgId,
      artistId: newArtistId,
      position: 0,
    });

    // Follow the new artist with the schema defaults (Album only)
    await db.insert(followedArtists).values({
      libraryId,
      artistId: newArtistId,
      mode: 'auto',
      createdAt: new Date(),
    });

    // A single is outside the default includePrimary: no gap
    const data: GapsRecomputeJobData = { libraryId };
    await gapsRecomputeJob(ctx, data);
    const noGap = await db
      .select()
      .from(gaps)
      .where(and(eq(gaps.libraryId, libraryId), eq(gaps.subjectId, newRgId)));
    expect(noGap).toHaveLength(0);

    // Widen the artist's rules to singles and recompute
    await db.update(followedArtists)
      .set({ includePrimary: ['Album', 'Single'] })
      .where(and(eq(followedArtists.libraryId, libraryId), eq(followedArtists.artistId, newArtistId)));
    await gapsRecomputeJob(ctx, data);

    // The new release group should have a missing_album gap
    const newGap = await db
      .select()
      .from(gaps)
      .where(
        and(
          eq(gaps.libraryId, libraryId),
          eq(gaps.subjectId, newRgId),
          eq(gaps.kind, 'missing_album')
        )
      )
      .limit(1);

    expect(newGap[0]).toBeDefined();
    expect(newGap[0]?.details).toEqual({
      title: 'Another Album',
      primaryType: 'Single',
    });

    // Cleanup
    await db.delete(followedArtists).where(eq(followedArtists.artistId, newArtistId));
    await db.delete(releaseGroupArtists).where(eq(releaseGroupArtists.artistId, newArtistId));
    await db.delete(releaseGroups).where(eq(releaseGroups.id, newRgId));
    await db.delete(artists).where(eq(artists.id, newArtistId));
  });

  it('excludes release groups whose secondary type the follow rules exclude', async () => {
    const liveRgId = randomUUID();
    await db.insert(releaseGroups).values({
      id: liveRgId,
      mbid: randomUUID(),
      title: 'Live at Somewhere',
      primaryType: 'Album',
      secondaryTypes: ['Live'],
    });
    await db.insert(releaseGroupArtists).values({ releaseGroupId: liveRgId, artistId, position: 0 });

    await gapsRecomputeJob(ctx, { libraryId });

    const rows = await db
      .select()
      .from(gaps)
      .where(and(eq(gaps.libraryId, libraryId), eq(gaps.subjectId, liveRgId)));
    expect(rows).toHaveLength(0);

    await db.delete(releaseGroupArtists).where(eq(releaseGroupArtists.releaseGroupId, liveRgId));
    await db.delete(releaseGroups).where(eq(releaseGroups.id, liveRgId));
  });

  it('null per-artist columns inherit the library followRules', async () => {
    const soloArtistId = randomUUID();
    const singleRgId = randomUUID();
    await db.insert(artists).values({ id: soloArtistId, mbid: randomUUID(), name: 'Singles Artist' });
    await db.insert(releaseGroups).values({ id: singleRgId, mbid: randomUUID(), title: 'Hit Single', primaryType: 'Single' });
    await db.insert(releaseGroupArtists).values({ releaseGroupId: singleRgId, artistId: soloArtistId, position: 0 });
    await db.insert(followedArtists).values({
      libraryId,
      artistId: soloArtistId,
      mode: 'manual',
      includePrimary: null,
      excludeSecondary: null,
    });

    // Library never set rules → built-in default (Album only) → no gap
    await gapsRecomputeJob(ctx, { libraryId });
    let rows = await db.select().from(gaps).where(and(eq(gaps.libraryId, libraryId), eq(gaps.subjectId, singleRgId)));
    expect(rows).toHaveLength(0);

    // Library says singles count → the inheriting artist gets the gap
    await db.update(libraries)
      .set({ settings: { followRules: { includePrimary: ['Album', 'Single'] } } })
      .where(eq(libraries.id, libraryId));
    await gapsRecomputeJob(ctx, { libraryId });
    rows = await db.select().from(gaps).where(and(eq(gaps.libraryId, libraryId), eq(gaps.subjectId, singleRgId)));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe('open');

    await db.update(libraries).set({ settings: {} }).where(eq(libraries.id, libraryId));
    await db.delete(followedArtists).where(eq(followedArtists.artistId, soloArtistId));
    await db.delete(releaseGroupArtists).where(eq(releaseGroupArtists.releaseGroupId, singleRgId));
    await db.delete(releaseGroups).where(eq(releaseGroups.id, singleRgId));
    await db.delete(artists).where(eq(artists.id, soloArtistId));
  });

  it('a release group shared by two followed artists yields one gap', async () => {
    const partnerId = randomUUID();
    await db.insert(artists).values({ id: partnerId, mbid: randomUUID(), name: 'Partner' });
    await db.insert(releaseGroupArtists).values({ releaseGroupId: releaseGroupId3, artistId: partnerId, position: 1 });
    await db.insert(followedArtists).values({ libraryId, artistId: partnerId, mode: 'manual', includePrimary: ['Album', 'EP'] });

    await db.delete(gaps).where(eq(gaps.libraryId, libraryId));
    // Two followed artists on one group must not trip the multi-row upsert
    await expect(gapsRecomputeJob(ctx, { libraryId })).resolves.toBeUndefined();

    const rows = await db.select().from(gaps).where(and(eq(gaps.libraryId, libraryId), eq(gaps.subjectId, releaseGroupId3)));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe('open');

    await db.delete(followedArtists).where(eq(followedArtists.artistId, partnerId));
    await db.delete(releaseGroupArtists).where(eq(releaseGroupArtists.artistId, partnerId));
    await db.delete(artists).where(eq(artists.id, partnerId));
  });
});
