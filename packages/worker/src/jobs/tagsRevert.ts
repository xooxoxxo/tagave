/**
 * tags.revert job — build a revert plan from journaled before-values
 * Per Spec §9.5 TAG-5: Every applied item stores before/after; revert is itself a plan.
 */

import { eq, and } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import {
  tagPlans,
  tagPlanItems,
} from '@liner/db';
import type { WorkerContext } from '../lib/context.js';
import type { TagPolicies } from '@liner/shared';

export interface TagsRevertJobData {
  planId: string;
}

/**
 * Build a revert plan from an applied tag plan.
 * The revert plan contains items that restore files to their before-state.
 */
export async function tagsRevertJob(ctx: WorkerContext, data: TagsRevertJobData) {
  const { planId } = data;
  const { db, logger } = ctx;

  // Fetch the original plan
  const plans = await db
    .select()
    .from(tagPlans)
    .where(eq(tagPlans.id, planId));

  if (plans.length === 0) {
    throw new Error(`Tag plan not found: ${planId}`);
  }

  const originalPlan = plans[0]!;

  // Get all applied items from the original plan
  const appliedItems = await db
    .select()
    .from(tagPlanItems)
    .where(
      and(
        eq(tagPlanItems.tagPlanId, planId),
        eq(tagPlanItems.status, 'applied')
      )
    );

  if (appliedItems.length === 0) {
    throw new Error(`No applied items found in plan: ${planId}`);
  }

  // Create a new revert plan
  const revertPlanId = randomUUID();
  const revertPlanName = `Revert ${originalPlan.name}`;

  // Build revert policy: overwrite all fields with before-values
  const originalPolicy = typeof originalPlan.policy === 'string'
    ? JSON.parse(originalPlan.policy)
    : originalPlan.policy;

  const revertPolicy: TagPolicies = {
    preset: 'custom',
    id3Version: originalPolicy.id3Version || '2.4',
    multiValueSeparator: originalPolicy.multiValueSeparator || '; ',
    overrides: {
      // Revert sets all canonical fields to 'overwrite' with before-values
      title: 'overwrite',
      artist: 'overwrite',
      artistsort: 'overwrite',
      album: 'overwrite',
      albumartist: 'overwrite',
      albumartistsort: 'overwrite',
      date: 'overwrite',
      originaldate: 'overwrite',
      tracknumber: 'overwrite',
      totaltracks: 'overwrite',
      discnumber: 'overwrite',
      totaldiscs: 'overwrite',
      discsubtitle: 'overwrite',
      genre: 'overwrite',
      compilation: 'overwrite',
      label: 'overwrite',
      catalognumber: 'overwrite',
      barcode: 'overwrite',
      media: 'overwrite',
      releasecountry: 'overwrite',
      releasestatus: 'overwrite',
      releasetype: 'overwrite',
      isrc: 'overwrite',
      musicbrainz_albumid: 'overwrite',
      musicbrainz_releasegroupid: 'overwrite',
      musicbrainz_albumartistid: 'overwrite',
      musicbrainz_artistid: 'overwrite',
      musicbrainz_recordingid: 'overwrite',
      musicbrainz_releasetrackid: 'overwrite',
      acoustid_id: 'overwrite',
      discogs_release_id: 'overwrite',
      discogs_master_id: 'overwrite',
    },
  };

  // Insert the revert plan
  await db.insert(tagPlans).values({
    id: revertPlanId,
    libraryId: originalPlan.libraryId,
    name: revertPlanName,
    scope: originalPlan.scope,
    policy: revertPolicy,
    status: 'draft',
    stats: {},
    createdBy: originalPlan.createdBy,
    createdAt: new Date(),
  });

  // Create revert items: swap before/after so applying them restores the before-state
  for (const appliedItem of appliedItems) {
    const beforeTags = typeof appliedItem.before === 'string'
      ? JSON.parse(appliedItem.before)
      : appliedItem.before;

    const afterTags = typeof appliedItem.after === 'string'
      ? JSON.parse(appliedItem.after)
      : appliedItem.after;

    const revertItemId = randomUUID();

    // For the revert plan, the "after" value is the original "before" value
    // The "before" value is the current "after" value
    // audioHashBefore is the current hash (from audioHashAfter of applied item)
    // audioHashAfter is the original hash (from audioHashBefore of applied item) - should match after revert
    await db.insert(tagPlanItems).values({
      id: revertItemId,
      tagPlanId: revertPlanId,
      audioFileId: appliedItem.audioFileId,
      before: afterTags, // Current state (what was applied)
      after: beforeTags, // Revert to original state
      diff: {}, // Revert diffs will be computed by tagsPreview
      status: 'pending',
      audioHashBefore: appliedItem.audioHashAfter, // Current hash
      audioHashAfter: appliedItem.audioHashBefore, // Original hash (must match after revert)
    });
  }

  logger.info(
    { planId, revertPlanId, itemCount: appliedItems.length },
    'Revert plan created'
  );

  // The revert plan is now in 'draft' status and ready to be previewed.
  // The user can preview it with POST /tag-plans/{revertPlanId}/preview
  // and then apply it with POST /tag-plans/{revertPlanId}/apply
}
