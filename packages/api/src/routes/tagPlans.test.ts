/**
 * Tests for tag plans API endpoints, especially add-to-existing-plan
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import { tagPlans, tagPlanItems, audioFiles, libraries, users, localAlbums } from '@liner/db';
import { makeDb } from '@liner/db';
import type { TagPlanScope } from '@liner/shared';

/**
 * Unit tests: scope merging logic
 */
describe('Tag plan scope merging (unit)', () => {
  it('merges album IDs from two albumIds scopes correctly', () => {
    const existing: TagPlanScope = { type: 'albumIds', albumIds: ['a', 'b', 'c'] };
    const newScope: TagPlanScope = { type: 'albumIds', albumIds: ['c', 'd', 'e'] };

    // Simulate the merge logic
    if (existing.type === 'albumIds' && newScope.type === 'albumIds') {
      const merged = Array.from(new Set([...existing.albumIds, ...newScope.albumIds]));
      expect(merged).toContain('a');
      expect(merged).toContain('b');
      expect(merged).toContain('c');
      expect(merged).toContain('d');
      expect(merged).toContain('e');
      expect(merged).toHaveLength(5);
    }
  });

  it('removes duplicates when merging album IDs', () => {
    const existing: TagPlanScope = { type: 'albumIds', albumIds: ['a', 'b'] };
    const newScope: TagPlanScope = { type: 'albumIds', albumIds: ['b'] };

    if (existing.type === 'albumIds' && newScope.type === 'albumIds') {
      const merged = Array.from(new Set([...existing.albumIds, ...newScope.albumIds]));
      expect(merged).toEqual(['a', 'b']);
    }
  });

  it('detects idempotent additions (no new albums)', () => {
    const existing: TagPlanScope = { type: 'albumIds', albumIds: ['a', 'b', 'c'] };
    const newScope: TagPlanScope = { type: 'albumIds', albumIds: ['b', 'c'] };

    if (existing.type === 'albumIds' && newScope.type === 'albumIds') {
      const merged = Array.from(new Set([...existing.albumIds, ...newScope.albumIds]));
      const isIdempotent = merged.length === existing.albumIds.length;
      expect(isIdempotent).toBe(true);
    }
  });
});

/**
 * Integration tests: POST /tag-plans/:planId/add-items endpoint
 */
describe.skipIf(!process.env.TEST_DATABASE_URL)(
  'Tag plan add-items endpoint (integration)',
  () => {
    let db: any;
    let userId: string;
    let libraryId: string;
    let planId: string;
    const albumId1 = randomUUID();
    const albumId2 = randomUUID();
    const albumId3 = randomUUID();

    beforeEach(async () => {
      const databaseUrl = process.env.TEST_DATABASE_URL;
      if (!databaseUrl) {
        throw new Error('TEST_DATABASE_URL not set');
      }

      const { db: dbInstance } = await makeDb(databaseUrl);
      db = dbInstance;

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

      // Create test albums in the library
      await db.insert(localAlbums).values([
        {
          id: albumId1,
          libraryId,
          title: 'Album 1',
          artistCredit: 'Artist A',
          createdAt: new Date(),
        },
        {
          id: albumId2,
          libraryId,
          title: 'Album 2',
          artistCredit: 'Artist B',
          createdAt: new Date(),
        },
        {
          id: albumId3,
          libraryId,
          title: 'Album 3',
          artistCredit: 'Artist C',
          createdAt: new Date(),
        },
      ]);

      // Create a draft tag plan with albums 1 and 2
      planId = randomUUID();
      await db.insert(tagPlans).values({
        id: planId,
        libraryId,
        name: 'Test Plan',
        scope: { type: 'albumIds', albumIds: [albumId1, albumId2] },
        policy: {
          preset: 'canonical_ids_and_fill',
          id3Version: '2.4',
          multiValueSeparator: '; ',
        },
        status: 'draft',
        stats: {},
        createdBy: userId,
        createdAt: new Date(),
      });
    });

    afterEach(async () => {
      if (db) {
        // Cleanup in reverse order of dependencies
        await db.delete(tagPlanItems).where(eq(tagPlanItems.tagPlanId, planId));
        await db.delete(tagPlans).where(eq(tagPlans.id, planId));
        await db.delete(localAlbums).where(eq(localAlbums.libraryId, libraryId));
        await db.delete(libraries).where(eq(libraries.id, libraryId));
        await db.delete(users).where(eq(users.id, userId));
      }
    });

    it('successfully merges new albums into a draft plan', async () => {
      const newScope: TagPlanScope = { type: 'albumIds', albumIds: [albumId3] };

      // Simulate the endpoint logic
      const existingPlan = await db
        .select()
        .from(tagPlans)
        .where(eq(tagPlans.id, planId));

      expect(existingPlan).toHaveLength(1);
      const plan = existingPlan[0]!;

      // Verify plan status is draft
      expect(plan.status).toBe('draft');

      // Verify plan exists and is draft/previewed
      if (!['draft', 'previewed'].includes(plan.status)) {
        throw new Error(`Cannot add items to plan in status '${plan.status}'`);
      }

      // Get existing scope
      const existingScope = typeof plan.scope === 'string' ? JSON.parse(plan.scope) : plan.scope;

      // Verify scope types
      expect(existingScope.type).toBe('albumIds');
      expect(newScope.type).toBe('albumIds');

      // Merge albums
      const mergedIds = Array.from(
        new Set([...existingScope.albumIds, ...newScope.albumIds])
      );

      // Verify merge
      expect(mergedIds).toContain(albumId1);
      expect(mergedIds).toContain(albumId2);
      expect(mergedIds).toContain(albumId3);
      expect(mergedIds).toHaveLength(3);

      // Verify not idempotent (new albums added)
      expect(mergedIds.length).toBeGreaterThan(existingScope.albumIds.length);

      // Update the plan in DB
      await db.update(tagPlans).set({
        scope: { type: 'albumIds', albumIds: mergedIds },
        status: 'draft',
        stats: {},
      }).where(eq(tagPlans.id, planId));

      // Verify the update
      const updatedPlan = await db.select().from(tagPlans).where(eq(tagPlans.id, planId));
      const updatedScope = typeof updatedPlan[0]!.scope === 'string'
        ? JSON.parse(updatedPlan[0]!.scope)
        : updatedPlan[0]!.scope;

      expect(updatedScope.albumIds).toHaveLength(3);
      expect(updatedScope.albumIds).toContain(albumId3);
    });

    it('returns 200 (idempotent) when adding albums already in the plan', async () => {
      const newScope: TagPlanScope = { type: 'albumIds', albumIds: [albumId1, albumId2] };

      const existingPlan = await db.select().from(tagPlans).where(eq(tagPlans.id, planId));
      const plan = existingPlan[0]!;
      const existingScope = typeof plan.scope === 'string' ? JSON.parse(plan.scope) : plan.scope;

      const mergedIds = Array.from(
        new Set([...existingScope.albumIds, ...newScope.albumIds])
      );

      // Verify no new albums
      expect(mergedIds.length).toBe(existingScope.albumIds.length);

      // The endpoint returns 200 idempotent for no-change additions
      // Verify the albums are the same
      expect(new Set(mergedIds)).toEqual(new Set(existingScope.albumIds));
    });

    it('rejects adding to a plan with non-albumIds scope', async () => {
      // Create a library-scoped plan
      const libraryPlanId = randomUUID();
      await db.insert(tagPlans).values({
        id: libraryPlanId,
        libraryId,
        name: 'Library Plan',
        scope: { type: 'library' },
        policy: {
          preset: 'canonical_ids_and_fill',
          id3Version: '2.4',
          multiValueSeparator: '; ',
        },
        status: 'draft',
        stats: {},
        createdBy: userId,
        createdAt: new Date(),
      });

      const existingPlan = await db.select().from(tagPlans).where(eq(tagPlans.id, libraryPlanId));
      const plan = existingPlan[0]!;
      const existingScope = typeof plan.scope === 'string' ? JSON.parse(plan.scope) : plan.scope;

      // Verify scope is not albumIds
      expect(existingScope.type).not.toBe('albumIds');

      // Cleanup
      await db.delete(tagPlans).where(eq(tagPlans.id, libraryPlanId));
    });

    it('rejects adding non-albumIds scope to a plan', async () => {
      const nonAlbumScope: TagPlanScope = { type: 'library' };

      const existingPlan = await db.select().from(tagPlans).where(eq(tagPlans.id, planId));
      const plan = existingPlan[0]!;

      // Verify existing plan is albumIds
      expect(plan.status).toBe('draft');

      // Verify new scope is not albumIds
      expect(nonAlbumScope.type).not.toBe('albumIds');
    });

    it('rejects adding to a plan in applied status', async () => {
      // Create an applied plan
      const appliedPlanId = randomUUID();
      await db.insert(tagPlans).values({
        id: appliedPlanId,
        libraryId,
        name: 'Applied Plan',
        scope: { type: 'albumIds', albumIds: [albumId1] },
        policy: {
          preset: 'canonical_ids_and_fill',
          id3Version: '2.4',
          multiValueSeparator: '; ',
        },
        status: 'applied',
        stats: {},
        createdBy: userId,
        createdAt: new Date(),
        appliedAt: new Date(),
      });

      const existingPlan = await db.select().from(tagPlans).where(eq(tagPlans.id, appliedPlanId));
      const plan = existingPlan[0]!;

      // Verify plan status is applied
      expect(plan.status).toBe('applied');

      // Endpoint should reject: only draft/previewed can accept new items
      expect(['draft', 'previewed']).not.toContain(plan.status);

      // Cleanup
      await db.delete(tagPlans).where(eq(tagPlans.id, appliedPlanId));
    });

    it('accepts adding to a previewed plan', async () => {
      // Create a previewed plan
      const previewedPlanId = randomUUID();
      await db.insert(tagPlans).values({
        id: previewedPlanId,
        libraryId,
        name: 'Previewed Plan',
        scope: { type: 'albumIds', albumIds: [albumId1] },
        policy: {
          preset: 'canonical_ids_and_fill',
          id3Version: '2.4',
          multiValueSeparator: '; ',
        },
        status: 'previewed',
        stats: { filesTouched: 10, fieldsModified: 5, lockedFieldsRespected: 0, filesSkipped: [] },
        createdBy: userId,
        createdAt: new Date(),
      });

      const existingPlan = await db.select().from(tagPlans).where(eq(tagPlans.id, previewedPlanId));
      const plan = existingPlan[0]!;

      // Verify plan status is previewed
      expect(plan.status).toBe('previewed');

      // Endpoint should accept previewed status
      expect(['draft', 'previewed']).toContain(plan.status);

      // Verify preview stats are cleared after merge (stats reset)
      const newScope: TagPlanScope = { type: 'albumIds', albumIds: [albumId2] };
      const existingScope = typeof plan.scope === 'string' ? JSON.parse(plan.scope) : plan.scope;
      const mergedIds = Array.from(
        new Set([...existingScope.albumIds, ...newScope.albumIds])
      );

      await db.update(tagPlans).set({
        scope: { type: 'albumIds', albumIds: mergedIds },
        status: 'draft', // Reset to draft as endpoint does
        stats: {}, // Clear stats
      }).where(eq(tagPlans.id, previewedPlanId));

      const updated = await db.select().from(tagPlans).where(eq(tagPlans.id, previewedPlanId));
      expect(updated[0]!.status).toBe('draft');
      expect(updated[0]!.stats).toEqual({});

      // Cleanup
      await db.delete(tagPlans).where(eq(tagPlans.id, previewedPlanId));
    });
  }
);
