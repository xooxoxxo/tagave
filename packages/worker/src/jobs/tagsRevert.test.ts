/**
 * Tests for tags.revert job
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  tagPlans,
  tagPlanItems,
  libraries,
  users,
  audioFiles,
  scanRoots,
} from '@liner/db';
import type { TagDiffEntry } from '@liner/shared';
import { makeDb } from '@liner/db';
import type { WorkerContext } from '../lib/context.js';
import { tagsRevertJob } from './tagsRevert.js';
import pino from 'pino';

describe('tagsRevert job', () => {
  let ctx: WorkerContext;
  let dbClient: any;
  let userId: string;
  let libraryId: string;

  beforeAll(async () => {
    const databaseUrl = process.env.TEST_DATABASE_URL;
    if (!databaseUrl) {
      throw new Error('TEST_DATABASE_URL not set — these suites delete rows and must never run against DATABASE_URL');
    }

    const { db, client } = await makeDb(databaseUrl);
    dbClient = db;
    ctx = {
      db,
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
      settings: {
        tagWritesEnabled: true,
      },
      createdAt: new Date(),
    });
  });

  afterAll(async () => {
    // Cleanup is handled by DB cleanup
  });

  it('should build a revert plan from applied items', async () => {
    // Create a scan root for the library
    const scanRootId = randomUUID();
    await dbClient.insert(scanRoots).values({
      id: scanRootId,
      libraryId,
      path: '/test/music',
      displayName: 'Test Root',
      writable: true,
      probeWritable: true,
      enabled: true,
      createdAt: new Date(),
    });

    // Create an audio file (required for foreign key constraint)
    const audioFileId = randomUUID();
    await dbClient.insert(audioFiles).values({
      id: audioFileId,
      libraryId,
      scanRootId,
      relPath: 'test.flac',
      sizeBytes: 10000,
      container: 'FLAC',
      codec: 'FLAC',
      lossless: true,
      durationMs: 180000,
      sampleRate: 44100,
      bitDepth: 16,
      channels: 2,
      status: 'present',
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
    });

    // Create an original plan
    const planId = randomUUID();
    await dbClient.insert(tagPlans).values({
      id: planId,
      libraryId,
      name: 'Original Plan',
      scope: { type: 'library' },
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

    // Create applied items
    const itemId = randomUUID();

    const beforeTags = {
      title: 'Old Title',
      artist: 'Old Artist',
      album: 'Old Album',
    };

    const afterTags = {
      title: 'New Title',
      artist: 'New Artist',
      album: 'New Album',
    };

    await dbClient.insert(tagPlanItems).values({
      id: itemId,
      tagPlanId: planId,
      audioFileId,
      before: beforeTags,
      after: afterTags,
      diff: [
        {
          field: 'title',
          before: 'Old Title',
          after: 'New Title',
          reason: 'policy:overwrite',
        },
      ],
      status: 'applied',
      audioHashBefore: 'hash-before',
      audioHashAfter: 'hash-before',
      sizeAfter: 1000000,
      mtimeAfter: Date.now(),
      appliedAt: new Date(),
    });

    // Call tagsRevertJob
    await tagsRevertJob(ctx, { planId });

    // Verify revert plan was created
    const revertPlans = await dbClient
      .select()
      .from(tagPlans)
      .where(eq(tagPlans.libraryId, libraryId));

    expect(revertPlans.length).toBe(2); // Original + revert

    const revertPlan = revertPlans.find((p: any) => p.name.startsWith('Revert'));
    expect(revertPlan).toBeDefined();
    expect(revertPlan?.status).toBe('draft');

    // Verify revert items were created
    const revertItems = await dbClient
      .select()
      .from(tagPlanItems)
      .where(eq(tagPlanItems.tagPlanId, revertPlan.id));

    expect(revertItems.length).toBe(1);

    const revertItem = revertItems[0]!;
    expect(revertItem.status).toBe('pending');
    expect(revertItem.audioFileId).toBe(audioFileId);

    // Verify before/after are swapped: revert.after = original.before
    const revertAfter = typeof revertItem.after === 'string'
      ? JSON.parse(revertItem.after)
      : revertItem.after;

    expect(revertAfter).toEqual(beforeTags);

    // Verify hashes are swapped
    expect(revertItem.audioHashBefore).toBe('hash-before');
    expect(revertItem.audioHashAfter).toBe('hash-before');

    // Verify policy is set to overwrite all fields
    const policy = typeof revertPlan.policy === 'string'
      ? JSON.parse(revertPlan.policy)
      : revertPlan.policy;

    expect(policy.preset).toBe('custom');
    expect(policy.overrides.title).toBe('overwrite');
    expect(policy.overrides.artist).toBe('overwrite');
    expect(policy.overrides.album).toBe('overwrite');
  });

  it('should throw error if plan has no applied items', async () => {
    // Create a plan with no applied items
    const emptyPlanId = randomUUID();
    await dbClient.insert(tagPlans).values({
      id: emptyPlanId,
      libraryId,
      name: 'Empty Plan',
      scope: { type: 'library' },
      policy: {
        preset: 'canonical_ids_and_fill',
      },
      status: 'applied',
      stats: {},
      createdBy: userId,
      createdAt: new Date(),
      appliedAt: new Date(),
    });

    // Attempt to revert should fail
    await expect(tagsRevertJob(ctx, { planId: emptyPlanId })).rejects.toThrow(
      'No applied items found'
    );
  });

  it('should compute diffs for revert items (finding 2)', async () => {
    // Create a scan root for the library
    const scanRootId = randomUUID();
    await dbClient.insert(scanRoots).values({
      id: scanRootId,
      libraryId,
      path: '/test/music',
      displayName: 'Test Root',
      writable: true,
      probeWritable: true,
      enabled: true,
      createdAt: new Date(),
    });

    // Create an audio file
    const audioFileId = randomUUID();
    await dbClient.insert(audioFiles).values({
      id: audioFileId,
      libraryId,
      scanRootId,
      relPath: 'test2.flac',
      sizeBytes: 10000,
      container: 'FLAC',
      codec: 'FLAC',
      lossless: true,
      durationMs: 180000,
      sampleRate: 44100,
      bitDepth: 16,
      channels: 2,
      status: 'present',
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
    });

    // Create an original plan
    const planId = randomUUID();
    await dbClient.insert(tagPlans).values({
      id: planId,
      libraryId,
      name: 'Original Plan 2',
      scope: { type: 'library' },
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

    // Create applied item with non-empty diffs
    const itemId = randomUUID();

    const beforeTags = {
      title: 'Old Title',
      artist: 'Old Artist',
      album: 'Old Album',
    };

    const afterTags = {
      title: 'New Title',
      artist: 'New Artist',
      album: 'New Album',
    };

    await dbClient.insert(tagPlanItems).values({
      id: itemId,
      tagPlanId: planId,
      audioFileId,
      before: beforeTags,
      after: afterTags,
      diff: [
        {
          field: 'title',
          before: 'Old Title',
          after: 'New Title',
          reason: 'policy:overwrite',
        },
        {
          field: 'artist',
          before: 'Old Artist',
          after: 'New Artist',
          reason: 'policy:overwrite',
        },
      ],
      status: 'applied',
      audioHashBefore: 'hash-before',
      audioHashAfter: 'hash-before',
      sizeAfter: 1000000,
      mtimeAfter: Date.now(),
      appliedAt: new Date(),
    });

    // Call tagsRevertJob
    await tagsRevertJob(ctx, { planId });

    // Verify revert items have computed diffs (not empty)
    const revertPlans = await dbClient
      .select()
      .from(tagPlans)
      .where(eq(tagPlans.libraryId, libraryId));

    const revertPlan = revertPlans.find((p: any) => p.name.startsWith('Revert'));
    expect(revertPlan).toBeDefined();

    const revertItems = await dbClient
      .select()
      .from(tagPlanItems)
      .where(eq(tagPlanItems.tagPlanId, revertPlan.id));

    expect(revertItems.length).toBe(1);

    const revertItem = revertItems[0]!;

    // CRITICAL: diff should NOT be empty (finding 2)
    const revertDiff = typeof revertItem.diff === 'string'
      ? JSON.parse(revertItem.diff)
      : revertItem.diff;

    expect(Array.isArray(revertDiff)).toBe(true);
    expect(revertDiff.length).toBeGreaterThan(0);

    // Each diff should show the change needed to restore the original state
    const titleDiff = revertDiff.find((d: any) => d.field === 'title');
    expect(titleDiff).toBeDefined();
    expect(titleDiff?.before).toBe('New Title'); // Current
    expect(titleDiff?.after).toBe('Old Title'); // Target
    expect(titleDiff?.reason).toBe('revert');
  });
});
