/**
 * tags.apply job — safely write tags to audio files with journal and hash verification
 * Per Spec §9.5 TAG-4 and TAG-5: Apply is resumable, concurrency 2, journals before/after,
 * pauses on audio-hash mismatch (P0 defect), continues on other errors.
 */

import { eq, and, inArray, isNotNull, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import {
  tagPlans,
  tagPlanItems,
  files,
  scanRoots,
  libraries,
  gaps,
} from '@tagave/db';
import type { WorkerContext } from '../lib/context.js';
import { errorMessage } from '../lib/dbErrors.js';
import { SafeFileWriter } from '../lib/safeFileWriter.js';
import { MutagenTagWriter } from '../lib/tagWriter.js';
import type { IAudioMetadata } from 'music-metadata';
import path from 'node:path';
import type { TagDiffEntry } from '@tagave/shared';
import { audioHandler, tagSnapshotOf } from '@tagave/core/files';
import { currentFieldsFrom } from '@tagave/core';
import { fileGate } from '../lib/fileGate.js';
import type { GateStat } from '../lib/gatedPaths.js';
import { FolderOfflineError, isGateClosed } from '../lib/folderOffline.js';
import { requireOnline, rootOfPlan } from '../lib/parking.js';
import { valueKey } from './tagsPreview.js';
import { localTracks } from '@tagave/db';
import { clusterSingletonKey, relDirname, tagsDigest } from '../lib/helpers.js';
import { requestPlayerRescan } from '../lib/playerScan.js';
import { queueOrganizeAfterPlan } from './organize.js';
import { albumsChanged } from '../lib/albumCare.js';
import { runPlanSplits, type PlanSplitOutcome } from './planSplits.js';
import type { SplitDeps } from './filesSplit.js';
import { FlacTools } from '../lib/flacTools.js';
import type { TagPolicies } from '@tagave/shared';
import type { MaintenanceWork } from '@tagave/db';
import { PAUSED_OFFLINE_STAGE, runMaintenance, type MaintenanceRun } from '../lib/maintenance.js';

export interface TagsApplyJobData {
  planId: string;
  maintenance?: MaintenanceWork;
  /**
   * Set on the job's data when it parked on an offline music folder (the
   * parked row keeps it): the re-send applies only a plan still waiting or
   * applying, never one the owner paused or cancelled meanwhile.
   */
  waited?: true;
}

/** What the apply needs from outside; tests pass the split's tools and tag writer. */
export interface TagsApplyDeps {
  split?: Omit<SplitDeps, 'policy'>;
  claim?: MaintenanceRun;
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
 * What the sidecar is asked to write for one item: the fields a policy
 * changed, and the journalled before-values a revert restores. A revert
 * whose before-value was absent removes the tag (named in __delete__); no
 * other diff ever removes one, so missing data never blanks a tag.
 */
export function fieldsToWriteFrom(diffs: TagDiffEntry[]): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  const deletes: string[] = [];
  for (const d of diffs) {
    if (d.reason === 'policy:fill' || d.reason === 'policy:overwrite') {
      if (d.after !== null) out[d.field] = d.after;
    } else if (d.reason === 'revert') {
      const blank = d.after === null || (typeof d.after === 'string' && d.after === '') || (Array.isArray(d.after) && d.after.length === 0);
      if (blank) deletes.push(d.field);
      else out[d.field] = d.after as string | string[];
    }
  }
  if (deletes.length > 0) out['__delete__'] = deletes;
  return out;
}

/**
 * Apply a tag plan: write tags to files in pending status, update journal,
 * pause on hash mismatch, continue on other errors. Answers the offline
 * music folder's id when a split met it and the plan paused, else nothing.
 */
export async function tagsApplyJob(ctx: WorkerContext, data: TagsApplyJobData, deps: TagsApplyDeps = {}): Promise<string | undefined> {
  if (data.maintenance && !deps.claim) {
    await runMaintenance(ctx, data.maintenance, async (claim) => {
      const [before] = await ctx.sql<{ status: string }[]>`select status from tag_plans where id = ${data.planId}`;
      if (before?.status === 'applied') return { state: 'done', stage: 'Tag Plan applied' };
      if (!before || !['previewed', 'paused', 'applying', 'waiting'].includes(before.status)) {
        return { state: 'cancelled', stage: 'Tag Plan closed' };
      }
      await claim.update({ stage: 'Applying Tag Plan', checkpoint: { planId: data.planId } });
      const offlineRoot = await tagsApplyJob(ctx, data, { ...deps, claim });
      const [plan] = await ctx.sql<{ status: string; error: string | null }[]>`
        select status, stats->>'lastError' as error from tag_plans where id = ${data.planId}
      `;
      if (plan?.status === 'paused' && offlineRoot) {
        // a split met an offline folder: the owner's Continue, as for any split (Decision 2)
        return { state: 'interrupted', stage: PAUSED_OFFLINE_STAGE, error: plan.error, checkpoint: { planId: data.planId, offlineRootId: offlineRoot } };
      }
      if (plan?.status === 'paused') return { state: 'interrupted', stage: 'Tag Plan paused', error: plan.error };
      return { state: 'done', stage: plan?.status === 'partially_failed' ? 'Tag Plan finished with errors' : 'Tag Plan applied' };
    });
    return;
  }
  if (data.waited && !deps.claim) {
    // a parked job sent again: only a plan still waiting (or applying) goes on
    const [now] = await ctx.sql<{ status: string }[]>`select status from tag_plans where id = ${data.planId}`;
    if (!now || !['waiting', 'applying'].includes(now.status)) {
      ctx.logger.info({ planId: data.planId, status: now?.status ?? null }, 'tags.apply: the plan no longer waits for its music folder; nothing written');
      return;
    }
  }
  try {
    await applyPlan(ctx, data, deps);
  } catch (error) {
    if (error instanceof SplitOfflineError) {
      // A split met an offline folder: the plan pauses for the owner's Resume
      // and the job completes (no park, so nothing resumes on its own).
      ctx.logger.warn({ planId: data.planId, scanRootId: error.offline.scanRootId }, 'tags.apply: music folder offline during a split; plan paused');
      await deps.claim?.current();
      await parkPlan(ctx, data.planId, PAUSED_OFFLINE_STAGE, ['previewed', 'applying', 'waiting']);
      return error.offline.scanRootId;
    }
    if (error instanceof FolderOfflineError) {
      // The music folder went offline: the plan waits for it (never failed or
      // paused, its last error kept) and the error parks the job or the task.
      // The item cut off goes back to pending; its journal is checked on return.
      ctx.logger.warn({ planId: data.planId, scanRootId: error.scanRootId, reason: error.reason }, 'tags.apply: music folder offline; plan waiting');
      await deps.claim?.current();
      await waitPlan(ctx, data.planId);
      // the parked row keeps the job's data: its re-send checks the plan still waits
      if (!data.maintenance) data.waited = true;
      throw error;
    }
    if (isGateClosed(error)) {
      // The worker is stopping: the plan stays applying, its items back to
      // pending, and the job runs again (the journal check makes a cut-off write safe).
      await ctx.db
        .update(tagPlanItems)
        .set({ status: 'pending' })
        .where(and(eq(tagPlanItems.tagPlanId, data.planId), eq(tagPlanItems.status, 'applying')));
      throw error;
    }
    // A failure outside the per-item handler (a DB constraint, a missing
    // sidecar, a lost connection) used to leave the plan in 'applying' with
    // nothing written and no way forward (seen live 2026-09-08). Park it as
    // 'paused' with the message so the page shows it and Resume retries.
    const message = errorMessage(error);
    ctx.logger.error({ planId: data.planId, error: message }, 'tags.apply failed; plan paused');
    await deps.claim?.current();
    await parkPlan(ctx, data.planId, message, ['applying']);
    throw error;
  }
}

/**
 * Stops the plan: its applying items back to pending, the plan paused with
 * `message` as its last error, or (message null, offline) waiting with its
 * last error as it was. Only from the statuses in `from`: a plan the owner
 * paused or cancelled meanwhile stays as the owner left it.
 */
async function parkPlan(ctx: WorkerContext, planId: string, message: string | null, from: string[]) {
  // Whatever was written before the failure is re-clustered like a finished
  // apply, so a plan cancelled from 'paused' still shows its real albums.
  try {
    await reclusterWrittenDirs(ctx, planId);
  } catch (error) {
    ctx.logger.warn({ planId, error: String(error) }, 'tags.apply: could not queue re-cluster for a parked plan');
  }
  try {
    await ctx.db
      .update(tagPlanItems)
      .set({ status: 'pending' })
      .where(and(eq(tagPlanItems.tagPlanId, planId), eq(tagPlanItems.status, 'applying')));
    await ctx.db
      .update(tagPlans)
      .set(message === null
        // offline: waiting, the last error as it was
        ? { status: 'waiting' }
        : {
          status: 'paused',
          stats: sql`coalesce(${tagPlans.stats}, '{}'::jsonb) || jsonb_build_object('lastError', ${message}::text)`,
        })
      .where(and(eq(tagPlans.id, planId), inArray(tagPlans.status, from)));
  } catch (parkError) {
    ctx.logger.error({ planId, error: String(parkError) }, 'tags.apply: could not park the plan');
  }
}

/**
 * The statuses this run may claim the plan from: a re-sent parked job only a
 * plan still waiting (or applying); a fresh Apply or Resume also a previewed
 * or paused one (ruling R28).
 */
function claimableStatuses(data: TagsApplyJobData): string[] {
  return data.waited ? ['waiting', 'applying'] : ['previewed', 'paused', 'waiting', 'applying'];
}

/** The plan's music folder went offline: its applying items back to pending, an applying plan 'waiting'. */
async function waitPlan(ctx: WorkerContext, planId: string) {
  await parkPlan(ctx, planId, null, ['applying']);
}

/**
 * 0089: the plan's splits first (an album in one file becomes its tracks,
 * tagged with the plan's values), with the same tag-writes gate as every
 * item. The split's own sidecar is closed after.
 */
/** The plan's splits still to run (or to finish). */
async function splitsWaiting(ctx: WorkerContext, planId: string): Promise<number> {
  const [waiting] = (await ctx.sql`select count(*)::int as n from album_splits where tag_plan_id = ${planId} and (state = 'splitting' or (state = 'done' and write_checkpoint is not null))`) as unknown as Array<{ n: number }>;
  return waiting?.n ?? 0;
}

/** The music folder went offline while the plan still had splits to run. */
class SplitOfflineError extends Error {
  constructor(readonly offline: FolderOfflineError) {
    super(PAUSED_OFFLINE_STAGE);
  }
}

async function splitsFirst(ctx: WorkerContext, planId: string, policy: TagPolicies, libraryId: string, deps: TagsApplyDeps): Promise<PlanSplitOutcome> {
  const none: PlanSplitOutcome = { done: 0, failed: 0, tracks: 0, error: null };
  if ((await splitsWaiting(ctx, planId)) === 0) return none;
  const [lib] = (await ctx.sql`select settings from libraries where id = ${libraryId}`) as unknown as Array<{ settings: { tagWritesEnabled?: boolean } | null }>;
  if (lib?.settings?.tagWritesEnabled !== true) {
    // nothing ran: the splits wait for the next Apply
    if (!deps.claim) await ctx.sql`update album_splits set state = 'ready', updated_at = now() where tag_plan_id = ${planId} and state = 'splitting' and write_checkpoint is null`;
    throw new Error('Tag writes are off for this library');
  }
  // the page shows the plan at work while the tracks are written
  await ctx.sql`update tag_plans set status = 'applying' where id = ${planId} and status in ('previewed', 'paused', 'waiting')`;
  const check = {
    beforeWrite: deps.claim?.current ?? deps.split?.beforeWrite ?? (async () => undefined),
    checkpoint: deps.claim
      ? (stage: string) => deps.claim!.update({ stage })
      : deps.split?.checkpoint ?? (async () => undefined),
  };
  if (deps.split) return runPlanSplits(ctx, planId, policy, { ...deps.split, ...check });
  const tags = new MutagenTagWriter();
  try {
    return await runPlanSplits(ctx, planId, policy, { tools: new FlacTools(), tags, ...check });
  } finally {
    await tags.close();
  }
}

/** The splits' outcome, in the plan's stats (the page's "Split into 11 tracks · tagged"). */
async function recordSplits(ctx: WorkerContext, planId: string, s: PlanSplitOutcome): Promise<void> {
  if (s.done + s.failed === 0) return;
  await ctx.sql`update tag_plans set stats = coalesce(stats, '{}'::jsonb)
                  || jsonb_build_object('splitsDone', ${s.done}::int, 'splitsFailed', ${s.failed}::int, 'splitTracks', ${s.tracks}::int)
                  || ${s.error ? ctx.sql`jsonb_build_object('lastError', ${s.error}::text)` : ctx.sql`'{}'::jsonb`}
                 where id = ${planId}`;
}

async function applyPlan(ctx: WorkerContext, data: TagsApplyJobData, deps: TagsApplyDeps = {}) {
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

  // Get library settings: tagWritesEnabled (will re-check per item)
  const libs = await db
    .select()
    .from(libraries)
    .where(eq(libraries.id, libraryId));

  if (libs.length === 0) {
    throw new Error(`Library not found: ${libraryId}`);
  }

  // Note: Per-item gate checks happen before safeWriter.write() (finding 3)
  // to catch flips that occur between job start and item processing

  // A music folder the watch reads offline: the plan waits at once, without a gate deadline.
  // While the plan still has splits to run, an offline folder pauses it for the
  // owner instead (Decision 2, ruling R22): a split never resumes on its own.
  const planRoot = await rootOfPlan(ctx, planId);
  const splitting = (await splitsWaiting(ctx, planId)) > 0;
  let splits: PlanSplitOutcome;
  try {
    if (planRoot) {
      try {
        await requireOnline(ctx, planRoot);
      } catch (error) {
        // Offline before anything ran: the Apply (or Resume) this job is for
        // makes the plan applying, so it shows as waiting for its folder. A
        // re-sent parked job finds its plan waiting already.
        if (error instanceof FolderOfflineError && !data.waited && !splitting) {
          await ctx.sql`update tag_plans set status = 'applying' where id = ${planId} and status in ('previewed', 'paused')`;
        }
        throw error;
      }
    }
    // 0089: split first, then tag: an album in one file becomes its tracks
    // (already carrying the plan's values) before any item is written
    splits = await splitsFirst(ctx, planId, plan.policy as TagPolicies, libraryId, deps);
  } catch (error) {
    if (splitting && error instanceof FolderOfflineError) throw new SplitOfflineError(error);
    throw error;
  }
  await recordSplits(ctx, planId, splits);

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
    // All done (a plan that only split: its outcome is the split's)
    await db
      .update(tagPlans)
      .set({ status: splits.failed > 0 ? 'partially_failed' : 'applied', appliedAt: new Date() })
      .where(and(eq(tagPlans.id, planId), inArray(tagPlans.status, claimableStatuses(data))));
    return;
  }

  // Get file info for all items
  const fileIds = pendingItems.map((item) => item.audioFileId);
  const filesInPlan = await db
    .select()
    .from(files)
    .where(inArray(files.id, fileIds));

  // Create a map: audioFileId -> (audioFile, scanRoot)
  const fileInfoMap = new Map<string, { audioFile: typeof filesInPlan[0]; scanRoot: typeof roots[0] }>();

  // Get scan roots for all files
  const scanRootIds = Array.from(new Set(filesInPlan.map((f) => f.scanRootId)));
  const roots = await db
    .select()
    .from(scanRoots)
    .where(inArray(scanRoots.id, scanRootIds));

  const rootMap = new Map(roots.map((r) => [r.id, r]));
  for (const r of roots) if (r.id !== planRoot) await requireOnline(ctx, r.id);

  // Note: Scan root writable flag will be checked per-item before writing (finding 3)

  // Build file info map
  for (const file of filesInPlan) {
    const root = rootMap.get(file.scanRootId);
    if (!root) {
      throw new Error(`Scan root not found for file: ${file.id}`);
    }
    fileInfoMap.set(file.id, { audioFile: file, scanRoot: root });
  }

  // Update plan status to 'applying'. The first run also records how many
  // albums the files sat in before anything was written, so the results can
  // say "3 albums became 1" only when this plan did that (a resumed run keeps
  // the first count: its folders may have been re-clustered since).
  // Only from the statuses this run may claim: a Pause or Cancel made since
  // the job started stays as the owner left it, and nothing is written.
  const albumsBefore = await countAlbumsOf(ctx, fileIds);
  const claimed = await db
    .update(tagPlans)
    .set({
      status: 'applying', // a waiting plan too: its music folder is back
      stats: sql`case when coalesce(${tagPlans.stats}, '{}'::jsonb)->'albumsBefore' is not null then ${tagPlans.stats}
                 else coalesce(${tagPlans.stats}, '{}'::jsonb) || jsonb_build_object('albumsBefore', ${albumsBefore}::int) end`,
    })
    .where(and(eq(tagPlans.id, planId), inArray(tagPlans.status, claimableStatuses(data))))
    .returning({ id: tagPlans.id });
  if (claimed.length === 0) {
    logger.info({ planId }, 'tags.apply: the plan was paused or closed before the run began; nothing written');
    return;
  }

  // Mark every item we are about to write as 'applying'. Items already in
  // 'applying' belong to a run that died mid-batch; nothing confirmed them
  // written, and a rewrite of the same tags is idempotent, so retry them too.
  const itemsToProcess = pendingItems;
  await db
    .update(tagPlanItems)
    .set({ status: 'applying' })
    .where(inArray(tagPlanItems.id, itemsToProcess.map((item) => item.id)));

  // Process items with concurrency 2. Every file call goes through the file
  // gate, with one writer per music folder: a write that hangs counts stuck
  // against the folder of its own file.
  const writers = new Map<string, SafeFileWriter>();
  const writerFor = (rootId: string) => {
    let w = writers.get(rootId);
    if (!w) writers.set(rootId, (w = new SafeFileWriter(rootId)));
    return w;
  };

  const concurrency = 2;
  let hashMismatchEncountered = false;

  for (let i = 0; i < itemsToProcess.length; i += concurrency) {
    await deps.claim?.current();
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

          // The journal keeps the complete after-tag set; the file gets only
          // the fields the policy changed (a lock or no-change row is not a write).
          const afterTags = reconstructAfterTags(beforeTags, diffs);
          const fieldsToWrite = fieldsToWriteFrom(diffs as TagDiffEntry[]);

          // CRITICAL: Re-check gates immediately before writing (finding 3: per-item gate verification)
          // Check 1: scan root writable
          const freshScanRoot = await db
            .select()
            .from(scanRoots)
            .where(eq(scanRoots.id, audioFile.scanRootId))
            .then((rows) => rows[0]);

          if (!freshScanRoot || !freshScanRoot.writable) {
            // Gate closed: mark as skipped and pause the plan
            await db
              .update(tagPlanItems)
              .set({
                status: 'skipped',
                error: 'scan_root_gate_closed',
              })
              .where(eq(tagPlanItems.id, item.id));

            // Signal to pause the plan
            hashMismatchEncountered = true;
            logger.warn(
              { itemId: item.id, audioFileId: item.audioFileId, scanRootId: audioFile.scanRootId },
              'Tag apply: scan root writable gate closed'
            );
            return { success: false, hashMismatch: true }; // Treated as critical to pause
          }

          // Check 2: library tagWritesEnabled
          const freshLib = await db
            .select()
            .from(libraries)
            .where(eq(libraries.id, libraryId))
            .then((rows) => rows[0]);

          const tagWritesEnabled = (freshLib?.settings as any)?.tagWritesEnabled === true;
          if (!tagWritesEnabled) {
            // Gate closed: mark as skipped and pause the plan
            await db
              .update(tagPlanItems)
              .set({
                status: 'skipped',
                error: 'gate_closed',
              })
              .where(eq(tagPlanItems.id, item.id));

            // Signal to pause the plan
            hashMismatchEncountered = true;
            logger.warn(
              { itemId: item.id, audioFileId: item.audioFileId },
              'Tag apply: tagWritesEnabled gate closed'
            );
            return { success: false, hashMismatch: true }; // Treated as critical to pause
          }

          // 0081: a file whose tags already agree is in the plan only to move
          // (its path under the naming rules); nothing to write here
          if (Object.keys(fieldsToWrite).length === 0) {
            await db
              .update(tagPlanItems)
              .set({ status: 'applied', after: afterTags, appliedAt: new Date() })
              .where(eq(tagPlanItems.id, item.id));
            return { success: true };
          }

          const gate = fileGate();
          const writer = writerFor(scanRoot.id);

          // Compute audio-stream hash before writing
          let hashBefore: string;
          try {
            hashBefore = await gate.run<string>(scanRoot.id, { op: 'contentHash', handlerId: audioHandler.id, path: fullPath });
          } catch (hashError) {
            if (hashError instanceof FolderOfflineError || isGateClosed(hashError)) throw hashError;
            const message = hashError instanceof Error ? hashError.message : String(hashError);
            throw new Error(`hash_before_failed: ${message}`);
          }

          // A write the gate gave up on (its journal: the hash before, no hash
          // after) counts as not done: the audio must still be the journal's,
          // its temp copy goes, and a file that holds the new tags already is
          // marked applied without writing again.
          if (item.audioHashBefore && !item.audioHashAfter) {
            if (hashBefore !== item.audioHashBefore) {
              hashMismatchEncountered = true;
              await failItem(ctx, item.id, 'Audio-stream hash mismatch after a cut-off write');
              logger.warn({ itemId: item.id }, 'Tag apply: hash mismatch on a cut-off write (P0 defect)');
              return { success: false, hashMismatch: true };
            }
            const removed = await writer.removeStaleTemps(fullPath);
            if (removed > 0) logger.info({ itemId: item.id, removed }, 'Tag apply: removed the temp copy of a cut-off write');
            const now = await gate.run<IAudioMetadata>(scanRoot.id, { op: 'parseAudio', path: fullPath });
            if (holdsDiffs(now, diffs as TagDiffEntry[])) {
              await recordApplied(ctx, item.id, item.audioFileId, scanRoot.id, fullPath, afterTags, hashBefore, now);
              logger.info({ itemId: item.id, audioFileId: item.audioFileId }, 'Tag apply: a cut-off write had finished; marked applied');
              return { success: true };
            }
          }

          // Write tags using SafeFileWriter
          const writeOpts = {
            id3Version: (plan.policy as any)?.id3Version || '2.4',
            multiValueSeparator: (plan.policy as any)?.multiValueSeparator || '; ',
          };

          // The journal of this attempt: should the gate give up on the write,
          // the return checks the file against it before writing again.
          await db
            .update(tagPlanItems)
            .set({ audioHashBefore: hashBefore, audioHashAfter: null })
            .where(eq(tagPlanItems.id, item.id));
          const writeResult = await writer.write(fullPath, fieldsToWrite as typeof afterTags, writeOpts);

          if (writeResult.error) {
            // Check for hash mismatch
            if (writeResult.code === 'hash_mismatch') {
              hashMismatchEncountered = true;

              // Mark item as failed
              await failItem(ctx, item.id, writeResult.error);

              logger.warn(
                { itemId: item.id, error: writeResult.error },
                'Tag apply: hash mismatch (P0 defect)'
              );

              return { success: false, hashMismatch: true };
            } else {
              // Other error: mark as failed, plan continues
              await failItem(ctx, item.id, writeResult.error);

              logger.warn(
                { itemId: item.id, error: writeResult.error },
                'Tag apply: write failed'
              );

              return { success: false, hashMismatch: false };
            }
          }

          // Success: update item with journal and audio file metadata
          // Re-read the file to get final metadata
          const metadata = await gate.run<IAudioMetadata>(scanRoot.id, { op: 'parseAudio', path: fullPath });
          await recordApplied(ctx, item.id, item.audioFileId, scanRoot.id, fullPath, afterTags, hashBefore, metadata);

          logger.info({ itemId: item.id, audioFileId: item.audioFileId }, 'Tag apply: success');
          return { success: true };
        } catch (error) {
          // offline: not this item's failure; the plan waits (the batch rethrows it).
          // The gate closed (the worker is stopping): not the item's failure either.
          if (error instanceof FolderOfflineError || isGateClosed(error)) throw error;
          const message = error instanceof Error ? error.message : String(error);
          await failItem(ctx, item.id, message);

          logger.error({ itemId: item.id, error: message }, 'Tag apply: unexpected error');
          return { success: false };
        }
      })
    );

    // A music folder offline: the items written stay applied, the rest wait.
    const offline = results.find((r): r is PromiseRejectedResult => r.status === 'rejected' && r.reason instanceof FolderOfflineError);
    if (offline) throw offline.reason;
    const closed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected' && isGateClosed(r.reason));
    if (closed) throw closed.reason;

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
    // The files written before the stop form new albums too; a plan that is
    // then cancelled from here would otherwise show the old albums for good.
    await reclusterWrittenDirs(ctx, planId);
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
      const failed = await db
        .select({ id: tagPlanItems.id })
        .from(tagPlanItems)
        .where(and(eq(tagPlanItems.tagPlanId, planId), eq(tagPlanItems.status, 'failed')));
      const status = failed.length > 0 || splits.failed > 0 ? 'partially_failed' : 'applied';
      // Queued before the status flips, so the plan page never sees a
      // finished plan whose albums have not started updating yet.
      await reclusterWrittenDirs(ctx, planId);
      // 0081: then the files to their paths under the naming rules, one move
      // per album (files.move: journal, Undo); a blocked album keeps its place
      let movesQueued = 0;
      try {
        movesQueued = await queueOrganizeAfterPlan(ctx, planId);
      } catch (error) {
        logger.warn({ planId, error: String(error) }, 'tags.apply: could not queue the moves');
      }
      // only from 'applying': a plan the owner paused or cancelled meanwhile stays so
      const finished = await db
        .update(tagPlans)
        .set({
          status,
          appliedAt: new Date(),
          ...(movesQueued > 0 ? { stats: sql`coalesce(${tagPlans.stats}, '{}'::jsonb) || jsonb_build_object('movesQueued', ${movesQueued}::int)` } : {}),
        })
        .where(and(eq(tagPlans.id, planId), eq(tagPlans.status, 'applying')))
        .returning({ id: tagPlans.id });
      // A fully applied revert plan marks the plan it undid as reverted.
      const revertOf = (plan.policy as { preset?: string; revertOf?: string } | null);
      if (finished.length > 0 && status === 'applied' && revertOf?.preset === 'revert' && revertOf.revertOf) {
        await db
          .update(tagPlans)
          .set({ status: 'reverted' })
          .where(and(eq(tagPlans.id, revertOf.revertOf), inArray(tagPlans.status, ['applied', 'partially_failed', 'cancelled'])));
      }

      logger.info({ planId, failed: failed.length }, `Tag apply: finished (${status})`);
    } else {
      // Still more to process (e.g., after restart)
      // Keep status as 'applying'
      logger.info(
        { planId, remaining: remainingPending.length },
        'Tag apply: more items to process'
      );
    }
  }

  await relintTouchedAlbums(ctx, libraryId, fileIds);
}

/**
 * True when the file's tags (read through the gate) already hold every value
 * the diffs write: a write the gate gave up on had finished. A diff whose
 * value is blank removes the tag, so the tag must be gone.
 */
export function holdsDiffs(metadata: IAudioMetadata, diffs: TagDiffEntry[]): boolean {
  const written = diffs.filter((d) => d.reason === 'policy:fill' || d.reason === 'policy:overwrite' || d.reason === 'revert');
  if (written.length === 0) return false;
  const now = currentFieldsFrom(tagSnapshotOf(metadata)) as Record<string, string | string[] | null | undefined>;
  return written.every((d) => valueKey(now[d.field] ?? null) === valueKey(d.after));
}

/**
 * A failed item, for a reason that is not an offline folder: its error, and
 * no journal of a cut-off write left (before set, after empty), so a later
 * retry never reads a file replaced since as a P0 hash mismatch. A revert
 * item's born journal (both set) stays.
 */
async function failItem(ctx: WorkerContext, itemId: string, message: string): Promise<void> {
  await ctx.sql`
    update tag_plan_items
       set status = 'failed', error = ${message},
           audio_hash_before = case when audio_hash_after is null then null else audio_hash_before end
     where id = ${itemId}`;
}

/** The item applied with its journal, and the file's row as the walk would read it now (stat through the gate). */
async function recordApplied(
  ctx: WorkerContext, itemId: string, audioFileId: string, rootId: string, fullPath: string,
  afterTags: Record<string, unknown>, audioHash: string, metadata: IAudioMetadata,
): Promise<void> {
  // bigint: 64-bit inode numbers lose precision as a JS number (as the walk stats)
  const stats = await fileGate().run<GateStat>(rootId, { op: 'stat', path: fullPath, bigint: true });
  // Same snapshot shape scan.parse stores; a bare common block here
  // made preview, identify and the lint read the file as untagged.
  const rawTags = tagSnapshotOf(metadata);
  await ctx.db
    .update(tagPlanItems)
    .set({
      status: 'applied',
      after: afterTags, // Store the complete after-tag set
      audioHashBefore: audioHash,
      audioHashAfter: audioHash, // Hash unchanged per spec (verified by SafeFileWriter)
      sizeAfter: Number(stats.size),
      mtimeAfter: Math.trunc(Number(stats.mtimeMs)),
      appliedAt: new Date(),
    })
    .where(eq(tagPlanItems.id, itemId));
  // Update files in the walk's units, with fresh digests
  await ctx.db
    .update(files)
    .set(fileStateAfterWrite({ size: stats.size, mtimeMs: Number(stats.mtimeMs), dev: stats.dev, ino: stats.ino }, rawTags, audioHash))
    .where(eq(files.id, audioFileId));
}

/**
 * The files columns after tagave wrote an audio file, in the walk's units:
 * mtime in whole seconds (it was milliseconds, so the next walk saw every
 * written file as changed and re-parsed it), dev:ino, and both digests (the
 * old tags_digest stayed stale; core_tags_digest feeds move detection).
 */
export function fileStateAfterWrite(
  stats: { size: number | bigint; mtimeMs: number; dev: number | bigint; ino: number | bigint },
  rawTags: unknown,
  audioHash: string,
) {
  return {
    sizeBytes: Number(stats.size),
    mtime: Math.floor(stats.mtimeMs / 1000),
    inode: `${stats.dev}:${stats.ino}`,
    tagsRaw: rawTags,
    tagsDigest: tagsDigest(rawTags),
    coreTagsDigest: audioHandler.identityDigest(rawTags),
    tagsReadAt: new Date(),
    audioHash,
  };
}

/**
 * The albums a plan's files form come from their tags, but the scan never
 * re-reads a file the plan wrote: apply records the new size and mtime, so
 * the walk sees nothing changed and the albums kept the old title and artist
 * ("Various Artists" on an album the plan had just given one album artist).
 * Re-cluster every folder the plan wrote to, as a rescan would. Singleton per
 * folder, the same key scan.parse uses, so a re-cluster already queued for a
 * folder covers it.
 */
export async function reclusterWrittenDirs(ctx: Pick<WorkerContext, 'db' | 'sql' | 'boss' | 'logger'>, planId: string): Promise<number> {
  const rows = await ctx.db
    .selectDistinct({ libraryId: files.libraryId, scanRootId: files.scanRootId, relPath: files.relPath, fileId: files.id, scanRootPath: scanRoots.path })
    .from(tagPlanItems)
    .innerJoin(files, eq(files.id, tagPlanItems.audioFileId))
    .innerJoin(scanRoots, eq(scanRoots.id, files.scanRootId))
    .where(and(eq(tagPlanItems.tagPlanId, planId), eq(tagPlanItems.status, 'applied')));
  const dirs = new Map<string, { libraryId: string; scanRootId: string; dirPath: string }>();
  for (const r of rows) {
    const dirPath = relDirname(r.relPath);
    dirs.set(`${r.scanRootId}\n${dirPath}`, { libraryId: r.libraryId, scanRootId: r.scanRootId, dirPath });
  }
  let queued = 0;
  for (const d of dirs.values()) {
    try {
      await ctx.boss.send('cluster.dir', d, { singletonKey: clusterSingletonKey(d.scanRootId, d.dirPath), singletonSeconds: 30 });
      queued++;
    } catch (error) {
      ctx.logger.warn({ planId, dirPath: d.dirPath, error: String(error) }, 'tags.apply: could not queue re-cluster');
    }
  }
  if (dirs.size > 0) ctx.logger.info({ planId, dirs: dirs.size, queued }, 'tags.apply: re-cluster queued');
  // the player server re-reads the same folders (its watcher is off over NFS)
  await requestPlayerRescan(ctx, rows);
  return queued;
}

/** How many different albums hold these files now. */
async function countAlbumsOf(ctx: Pick<WorkerContext, 'db'>, fileIds: string[]): Promise<number> {
  if (fileIds.length === 0) return 0;
  const rows = await ctx.db
    .selectDistinct({ albumId: localTracks.localAlbumId })
    .from(localTracks)
    .where(and(inArray(localTracks.audioFileId, fileIds), isNotNull(localTracks.localAlbumId)));
  return rows.length;
}

/**
 * Quality chips on the album page come from gaps.recompute, which otherwise
 * runs nightly; re-lint just the albums this plan wrote so the page reflects
 * the new tags right away.
 */
async function relintTouchedAlbums(ctx: WorkerContext, libraryId: string, fileIds: string[]) {
  if (fileIds.length === 0) return;
  const rows = await ctx.db
    .selectDistinct({ albumId: localTracks.localAlbumId })
    .from(localTracks)
    .where(inArray(localTracks.audioFileId, fileIds));
  const albumIds = rows.map((r) => r.albumId).filter((id): id is string => !!id);
  if (albumIds.length === 0) return;
  // identity and tags changed: the album-level gaps now, the re-lint queued
  await albumsChanged(ctx, libraryId, albumIds);
}
