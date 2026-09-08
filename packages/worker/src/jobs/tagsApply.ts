/**
 * tags.apply job — safely write tags to audio files with journal and hash verification
 * Per Spec §9.5 TAG-4 and TAG-5: Apply is resumable, concurrency 2, journals before/after,
 * pauses on audio-hash mismatch (P0 defect), continues on other errors.
 */

import { eq, and, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import {
  tagPlans,
  tagPlanItems,
  audioFiles,
  scanRoots,
  libraries,
  gaps,
} from '@liner/db';
import { hashAudioStream } from '@liner/core';
import type { WorkerContext } from '../lib/context.js';
import { SafeFileWriter } from '../lib/safeFileWriter.js';
import { MutagenTagWriter } from '../lib/tagWriter.js';
import { parseFile } from 'music-metadata';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { TagDiffEntry } from '@liner/shared';

export interface TagsApplyJobData {
  planId: string;
}

/**
 * Reconstruct the complete after-tag set from before-tags and diffs
 */
function reconstructAfterTags(
  beforeTags: Record<string, any>,
  diffs: TagDiffEntry[]
): Record<string, any> {
  const after = { ...beforeTags };

  for (const diff of diffs) {
    after[diff.field] = diff.after;
  }

  return after;
}

/**
 * Apply a tag plan: write tags to files in pending status, update journal,
 * pause on hash mismatch, continue on other errors.
 */
export async function tagsApplyJob(ctx: WorkerContext, data: TagsApplyJobData) {
  const { planId } = data;
  const { db, logger } = ctx;

  // Fetch the plan
  const plans = await db
    .select()
    .from(tagPlans)
    .where(eq(tagPlans.id, planId));

  if (plans.length === 0) {
    throw new Error(`Tag plan not found: ${planId}`);
  }

  const plan = plans[0]!;
  const libraryId = plan.libraryId;

  // Get library settings: tagWritesEnabled
  const libs = await db
    .select()
    .from(libraries)
    .where(eq(libraries.id, libraryId));

  if (libs.length === 0) {
    throw new Error(`Library not found: ${libraryId}`);
  }

  const lib = libs[0]!;
  const tagWritesEnabled = (lib.settings as any)?.tagWritesEnabled === true;

  if (!tagWritesEnabled) {
    throw new Error('Tag writes are not enabled for this library');
  }

  // Get pending and applying items
  const pendingItems = await db
    .select()
    .from(tagPlanItems)
    .where(
      and(
        eq(tagPlanItems.tagPlanId, planId),
        inArray(tagPlanItems.status, ['pending', 'applying'])
      )
    );

  if (pendingItems.length === 0) {
    // All done
    await db
      .update(tagPlans)
      .set({ status: 'applied', appliedAt: new Date() })
      .where(eq(tagPlans.id, planId));
    return;
  }

  // Get file info for all items
  const fileIds = pendingItems.map((item) => item.audioFileId);
  const filesInPlan = await db
    .select()
    .from(audioFiles)
    .where(inArray(audioFiles.id, fileIds));

  // Create a map: audioFileId -> (audioFile, scanRoot)
  const fileInfoMap = new Map<string, { audioFile: typeof filesInPlan[0]; scanRoot: typeof roots[0] }>();

  // Get scan roots for all files
  const scanRootIds = Array.from(new Set(filesInPlan.map((f) => f.scanRootId)));
  const roots = await db
    .select()
    .from(scanRoots)
    .where(inArray(scanRoots.id, scanRootIds));

  const rootMap = new Map(roots.map((r) => [r.id, r]));

  // Check that all scan roots are writable
  for (const root of roots) {
    if (!root.writable) {
      throw new Error(`Scan root is not writable: ${root.path}`);
    }
  }

  // Build file info map
  for (const file of filesInPlan) {
    const root = rootMap.get(file.scanRootId);
    if (!root) {
      throw new Error(`Scan root not found for file: ${file.id}`);
    }
    fileInfoMap.set(file.id, { audioFile: file, scanRoot: root });
  }

  // Update plan status to 'applying'
  await db
    .update(tagPlans)
    .set({ status: 'applying' })
    .where(eq(tagPlans.id, planId));

  // Update all 'pending' items to 'applying'
  const itemsToProcess = pendingItems.filter((item) => item.status === 'pending');
  for (const item of itemsToProcess) {
    await db
      .update(tagPlanItems)
      .set({ status: 'applying' })
      .where(eq(tagPlanItems.id, item.id));
  }

  // Process items with concurrency 2
  const tagWriter = new MutagenTagWriter();
  const safeWriter = new SafeFileWriter(tagWriter);

  const concurrency = 2;
  let hashMismatchEncountered = false;

  for (let i = 0; i < itemsToProcess.length; i += concurrency) {
    const batch = itemsToProcess.slice(i, i + concurrency);
    const results = await Promise.allSettled(
      batch.map(async (item) => {
        try {
          const fileInfo = fileInfoMap.get(item.audioFileId);
          if (!fileInfo) {
            throw new Error('Audio file or scan root not found');
          }

          const { audioFile, scanRoot } = fileInfo;
          const fullPath = path.join(scanRoot.path, audioFile.relPath);

          // Parse the before tags from the item
          const beforeTags = typeof item.before === 'string' ? JSON.parse(item.before) : item.before;
          const diffs = typeof item.diff === 'string' ? JSON.parse(item.diff) : item.diff || [];

          // Reconstruct the complete after-tag set from before tags and diffs
          const afterTags = reconstructAfterTags(beforeTags, diffs);

          // Compute audio-stream hash before writing
          let hashBefore: string;
          try {
            const ext = path.extname(fullPath).toLowerCase().slice(1);
            hashBefore = await hashAudioStream(fullPath, ext);
          } catch (hashError) {
            const message = hashError instanceof Error ? hashError.message : String(hashError);
            throw new Error(`hash_before_failed: ${message}`);
          }

          // Write tags using SafeFileWriter
          const writeOpts = {
            id3Version: (plan.policy as any)?.id3Version || '2.4',
            multiValueSeparator: (plan.policy as any)?.multiValueSeparator || '; ',
          };

          const writeResult = await safeWriter.write(fullPath, afterTags, writeOpts);

          if (writeResult.error) {
            // Check for hash mismatch
            if (writeResult.code === 'hash_mismatch') {
              hashMismatchEncountered = true;

              // Mark item as failed
              await db
                .update(tagPlanItems)
                .set({
                  status: 'failed',
                  error: writeResult.error,
                })
                .where(eq(tagPlanItems.id, item.id));

              logger.warn(
                { itemId: item.id, error: writeResult.error },
                'Tag apply: hash mismatch (P0 defect)'
              );

              return { success: false, hashMismatch: true };
            } else {
              // Other error: mark as failed, plan continues
              await db
                .update(tagPlanItems)
                .set({
                  status: 'failed',
                  error: writeResult.error,
                })
                .where(eq(tagPlanItems.id, item.id));

              logger.warn(
                { itemId: item.id, error: writeResult.error },
                'Tag apply: write failed'
              );

              return { success: false, hashMismatch: false };
            }
          }

          // Success: update item with journal and audio file metadata
          // Re-read the file to get final metadata
          const metadata = await parseFile(fullPath);
          const stats = await fs.stat(fullPath);

          // Get tags_raw from the file
          const rawTags = metadata.common || {};

          // Update tag_plan_items with all journal fields
          await db
            .update(tagPlanItems)
            .set({
              status: 'applied',
              after: afterTags, // Store the complete after-tag set
              audioHashBefore: hashBefore,
              audioHashAfter: hashBefore, // Hash unchanged per spec (verified by SafeFileWriter)
              sizeAfter: Number(stats.size),
              mtimeAfter: stats.mtime?.getTime(),
              appliedAt: new Date(),
            })
            .where(eq(tagPlanItems.id, item.id));

          // Update audio_files with new metadata
          await db
            .update(audioFiles)
            .set({
              sizeBytes: Number(stats.size),
              mtime: stats.mtime?.getTime(),
              tagsRaw: rawTags,
              audioHash: hashBefore,
            })
            .where(eq(audioFiles.id, item.audioFileId));

          logger.info({ itemId: item.id, audioFileId: item.audioFileId }, 'Tag apply: success');
          return { success: true };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await db
            .update(tagPlanItems)
            .set({
              status: 'failed',
              error: message,
            })
            .where(eq(tagPlanItems.id, item.id));

          logger.error({ itemId: item.id, error: message }, 'Tag apply: unexpected error');
          return { success: false };
        }
      })
    );

    // Check for hash mismatch and stop processing if found
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value?.hashMismatch) {
        hashMismatchEncountered = true;
        break;
      }
    }

    if (hashMismatchEncountered) {
      break;
    }
  }

  // Update plan status based on results
  if (hashMismatchEncountered) {
    // Pause the plan
    await db
      .update(tagPlans)
      .set({ status: 'paused' })
      .where(eq(tagPlans.id, planId));

    // Raise an alert as a gap with kind='quality'
    await db.insert(gaps).values({
      id: randomUUID(),
      libraryId,
      kind: 'quality',
      subjectType: 'audio_file',
      subjectId: randomUUID(), // Generic subject for library-wide alert
      details: {
        reason: 'audio_hash_mismatch',
        planId,
      },
    });

    logger.error(
      { planId },
      'Tag apply: hash mismatch detected, plan paused and alert raised'
    );
  } else {
    // Check if all items are applied
    const remainingPending = await db
      .select()
      .from(tagPlanItems)
      .where(
        and(
          eq(tagPlanItems.tagPlanId, planId),
          inArray(tagPlanItems.status, ['pending', 'applying'])
        )
      );

    if (remainingPending.length === 0) {
      // All done
      await db
        .update(tagPlans)
        .set({ status: 'applied', appliedAt: new Date() })
        .where(eq(tagPlans.id, planId));

      logger.info({ planId }, 'Tag apply: all items processed successfully');
    } else {
      // Still more to process (e.g., after restart)
      // Keep status as 'applying'
      logger.info(
        { planId, remaining: remainingPending.length },
        'Tag apply: more items to process'
      );
    }
  }
}
