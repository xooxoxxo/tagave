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
import { CanonicalField, type TagDiffEntry, type TagPlanStats, type TagPolicies } from '@liner/shared';

export interface TagsRevertJobData {
  planId: string;
  /** id for the revert plan, chosen by the API so the page can open it; generated when absent */
  revertPlanId?: string;
}

type Value = string | string[] | null;

/** Same comparison the preview uses: trimmed strings, arrays as sorted sets, blank = absent. */
function valueKey(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) {
    const items = [...new Set(v.map((x) => String(x).trim()).filter(Boolean))].sort();
    return items.length === 0 ? '' : JSON.stringify(items);
  }
  if (typeof v === 'boolean') return v ? '1' : '';
  return String(v).trim();
}

const asValue = (v: unknown): Value => {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'boolean') return v ? '1' : null;
  return String(v);
};

/**
 * The diffs that take a file from what an applied item wrote (after) back to
 * what it carried before (before). A field that was absent before comes back
 * as null, which tags.apply turns into an explicit removal.
 */
export function revertDiffsFor(beforeTags: Record<string, unknown> | null, afterTags: Record<string, unknown> | null): TagDiffEntry[] {
  const before = beforeTags ?? {};
  const after = afterTags ?? {};
  const out: TagDiffEntry[] = [];
  for (const field of new Set([...Object.keys(after), ...Object.keys(before)])) {
    if (!(CANONICAL_FIELDS as readonly string[]).includes(field)) continue;
    if (valueKey(after[field]) === valueKey(before[field])) continue;
    out.push({
      field: field as TagDiffEntry['field'],
      before: asValue(after[field]),
      after: asValue(before[field]),
      reason: 'revert',
    });
  }
  return out;
}

const CANONICAL_FIELDS = Object.values(CanonicalField) as string[];

/**
 * Build a revert plan from an applied tag plan: one item per written file,
 * restoring its journalled before-values. The plan is born 'previewed' with
 * its diffs and stats already in place (there is nothing to recompute: the
 * journal is the source of truth, and a canonical re-preview would skip
 * every unidentified file), so the page can apply it straight away.
 */
export async function tagsRevertJob(ctx: WorkerContext, data: TagsRevertJobData) {
  const { planId } = data;
  const { db, logger } = ctx;

  const plans = await db
    .select()
    .from(tagPlans)
    .where(eq(tagPlans.id, planId));

  if (plans.length === 0) {
    throw new Error(`Tag plan not found: ${planId}`);
  }

  const originalPlan = plans[0]!;

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

  const revertPlanId = data.revertPlanId ?? randomUUID();
  // A retried job must not build the plan twice.
  const already = await db.select({ id: tagPlans.id }).from(tagPlans).where(eq(tagPlans.id, revertPlanId));
  if (already.length > 0) {
    logger.info({ planId, revertPlanId }, 'Revert plan already built');
    return;
  }

  const originalPolicy = (typeof originalPlan.policy === 'string'
    ? JSON.parse(originalPlan.policy)
    : originalPlan.policy) as Partial<TagPolicies>;

  const revertPolicy: TagPolicies = {
    preset: 'revert',
    id3Version: originalPolicy.id3Version || '2.4',
    multiValueSeparator: originalPolicy.multiValueSeparator || '; ',
    revertOf: planId,
  };

  const items = appliedItems.flatMap((appliedItem) => {
    const beforeTags = (typeof appliedItem.before === 'string' ? JSON.parse(appliedItem.before) : appliedItem.before) as Record<string, unknown> | null;
    const afterTags = (typeof appliedItem.after === 'string' ? JSON.parse(appliedItem.after) : appliedItem.after) as Record<string, unknown> | null;
    const diff = revertDiffsFor(beforeTags, afterTags);
    if (diff.length === 0) return [];
    return [{
      id: randomUUID(),
      tagPlanId: revertPlanId,
      audioFileId: appliedItem.audioFileId,
      before: afterTags, // what the file carries now (what was applied)
      after: beforeTags, // what it carried before the plan
      diff,
      status: 'pending' as const,
      audioHashBefore: appliedItem.audioHashAfter,
      audioHashAfter: appliedItem.audioHashBefore,
    }];
  });

  const stats: TagPlanStats = {
    filesTouched: items.length,
    fieldsModified: items.reduce((n, i) => n + i.diff.length, 0),
    lockedFieldsRespected: 0,
    filesSkipped: [],
    filesInScope: appliedItems.length,
    filesAlreadyCorrect: appliedItems.length - items.length,
    filesLockedOnly: 0,
  };

  await db.transaction(async (tx) => {
    await tx.insert(tagPlans).values({
      id: revertPlanId,
      libraryId: originalPlan.libraryId,
      name: `Revert ${originalPlan.name}`.slice(0, 255),
      scope: originalPlan.scope,
      policy: revertPolicy,
      status: 'previewed',
      stats,
      createdBy: originalPlan.createdBy,
      createdAt: new Date(),
    });
    for (let i = 0; i < items.length; i += 500) {
      await tx.insert(tagPlanItems).values(items.slice(i, i + 500));
    }
  });

  logger.info(
    { planId, revertPlanId, itemCount: items.length },
    'Revert plan created'
  );
}
