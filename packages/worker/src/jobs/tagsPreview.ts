import { eq, and, inArray } from 'drizzle-orm';
import {
  tagPlans,
  tagPlanItems,
  audioFiles,
  localAlbums,
  localTracks,
  scanRoots,
} from '@liner/db';
import { type TagPlanScope, type TagPolicies, type TagDiffEntry, type TagPlanStats } from '@liner/shared';
import type { WorkerContext } from '../lib/context.js';

/**
 * Mock ResolvedMetadataService for testing.
 * In production (XO-307-4), this will be replaced with the real service
 * that fetches canonical metadata from release/release-group/tracks + field_locks.
 *
 * For now, this returns fixture data keyed by audioFileId.
 */
class MockResolvedMetadataService {
  private fixtures: Record<string, Record<string, any>> = {};

  constructor() {
    // Initialize with empty fixtures - these will be populated by tests
    // In real implementation, this will query canonical metadata
  }

  setFixture(audioFileId: string, canonicalMetadata: Record<string, any>) {
    this.fixtures[audioFileId] = canonicalMetadata;
  }

  async getCanonicalMetadata(audioFileId: string): Promise<Record<string, any>> {
    // Return fixture if available, otherwise return empty object
    return this.fixtures[audioFileId] || {};
  }
}

const metadataService = new MockResolvedMetadataService();

export { metadataService };

/**
 * Apply tag policy to compute what the after value should be.
 * Per Spec §9.5 TAG-2: policy can be fill blanks only, overwrite with canonical,
 * or per-field rules.
 */
function applyPolicy(
  field: string,
  beforeValue: any,
  canonicalValue: any,
  policy: TagPolicies,
  isLocked: boolean
): { after: any; reason: 'locked' | 'no-change' | 'policy:fill' | 'policy:overwrite' } {
  if (isLocked) {
    return { after: beforeValue, reason: 'locked' };
  }

  // Check for per-field override
  const override: 'overwrite' | 'fill' | 'never' | undefined = policy.overrides ? (policy.overrides as any)[field] : undefined;
  const fieldPolicy = override || getPresetPolicy(policy.preset, field);

  if (fieldPolicy === 'never') {
    return { after: beforeValue, reason: 'no-change' };
  }

  if (fieldPolicy === 'fill') {
    // Fill blanks only
    if (beforeValue === null || beforeValue === undefined || beforeValue === '') {
      if (canonicalValue === null || canonicalValue === undefined || canonicalValue === '') {
        return { after: beforeValue, reason: 'no-change' };
      }
      return { after: canonicalValue, reason: 'policy:fill' };
    }
    return { after: beforeValue, reason: 'no-change' };
  }

  if (fieldPolicy === 'overwrite') {
    // Overwrite with canonical
    if (beforeValue === canonicalValue) {
      return { after: beforeValue, reason: 'no-change' };
    }
    return { after: canonicalValue, reason: 'policy:overwrite' };
  }

  return { after: beforeValue, reason: 'no-change' };
}

/**
 * Get the field policy from a preset.
 * Per M2 Tag Correction Plan section 1 Q5:
 * - Preset 'Canonical IDs + fill':
 *   - overwrite: musicbrainz_*, discogs_*, album, albumartist, albumartistsort,
 *     date, originaldate, tracknumber/totaltracks, discnumber/totaldiscs, label,
 *     catalognumber, barcode, media, releasecountry, releasestatus, releasetype
 *   - fill: title, artist, genre, compilation
 *   - never: comment, lyrics, ratings, replaygain, unknown/custom tags
 */
function getPresetPolicy(preset: string, field: string): 'overwrite' | 'fill' | 'never' {
  const overwrites = new Set([
    'musicbrainz_albumid',
    'musicbrainz_releasegroupid',
    'musicbrainz_albumartistid',
    'musicbrainz_artistid',
    'musicbrainz_recordingid',
    'musicbrainz_releasetrackid',
    'discogs_release_id',
    'discogs_master_id',
    'album',
    'albumartist',
    'albumartistsort',
    'date',
    'originaldate',
    'tracknumber',
    'totaltracks',
    'discnumber',
    'totaldiscs',
    'label',
    'catalognumber',
    'barcode',
    'media',
    'releasecountry',
    'releasestatus',
    'releasetype',
  ]);

  const fills = new Set([
    'title',
    'artist',
    'genre',
    'compilation',
  ]);

  const nevers = new Set([
    'comment',
    'lyrics',
  ]);

  if (preset === 'canonical_ids_and_fill') {
    if (overwrites.has(field)) return 'overwrite';
    if (fills.has(field)) return 'fill';
    if (nevers.has(field)) return 'never';
    // Default: never touch unknown/custom tags
    return 'never';
  }

  if (preset === 'fill_blanks_only') {
    return 'fill';
  }

  if (preset === 'overwrite_all') {
    if (nevers.has(field)) return 'never';
    return 'overwrite';
  }

  // 'custom' uses overrides only
  return 'never';
}

/**
 * Enumerate audio files matching the plan scope.
 * Per Spec §9.5 TAG-3: per-file diff computation.
 */
async function enumerateFilesForScope(
  db: WorkerContext['db'],
  libraryId: string,
  scope: TagPlanScope
): Promise<string[]> {

  if (scope.type === 'library') {
    // All audio files in the library
    const files = await db
      .select({ id: audioFiles.id })
      .from(audioFiles)
      .where(eq(audioFiles.libraryId, libraryId));
    return files.map((f) => f.id);
  }

  if (scope.type === 'artist') {
    // All albums by an artist - not directly supported yet
    // Would need to query through releases and albums
    return [];
  }

  if (scope.type === 'albumIds') {
    // Specific albums - get all tracks from these albums
    const tracks = await db
      .select({ audioFileId: localTracks.audioFileId })
      .from(localTracks)
      .where(scope.albumIds.length > 0 ? inArray(localTracks.localAlbumId, scope.albumIds) : undefined);

    return tracks.map((t) => t.audioFileId);
  }

  // filterQuery scope - not implemented yet (requires query builder)
  return [];
}

/**
 * Main job handler: tags.preview
 * Per Spec §9.5 TAG-3: "A plan produces a per-file diff (field, before, after,
 * reason/source) and an aggregate summary (files touched, fields by count,
 * locked fields respected, files skipped and why) before anything is written."
 *
 * No disk writes. Updates tag_plan.status = 'previewed' and tag_plan.stats.
 */
export async function tagsPreviewJob(ctx: WorkerContext, planId: string): Promise<void> {
  const db = ctx.db;

  // Fetch the plan
  const plan = await db
    .select()
    .from(tagPlans)
    .where(eq(tagPlans.id, planId))
    .then((rows) => rows[0]);

  if (!plan) {
    throw new Error(`Tag plan ${planId} not found`);
  }

  const libraryId = plan.libraryId;
  const scope = plan.scope as TagPlanScope;
  const policy = plan.policy as TagPolicies;

  // Enumerate matching files
  const fileIds = await enumerateFilesForScope(db, libraryId, scope);

  let filesTouched = 0;
  let fieldsModified = 0;
  let lockedFieldsRespected = 0;
  const filesSkipped: Array<{ audioFileId: string; reason: 'scan_root_not_writable' | 'audio_file_error'; message?: string }> = [];

  // Process each file
  for (const audioFileId of fileIds) {
    try {
      // Fetch file metadata
      const file = await db
        .select()
        .from(audioFiles)
        .where(eq(audioFiles.id, audioFileId))
        .then((rows) => rows[0]);

      if (!file) {
        filesSkipped.push({ audioFileId, reason: 'audio_file_error', message: 'File not found' });
        continue;
      }

      // Check if scan root is writable
      const scanRoot = await db
        .select()
        .from(scanRoots)
        .where(eq(scanRoots.id, file.scanRootId))
        .then((rows) => rows[0]);

      if (!scanRoot || !scanRoot.writable) {
        filesSkipped.push({
          audioFileId,
          reason: 'scan_root_not_writable',
          ...(scanRoot?.path && { message: scanRoot.path }),
        });
        continue;
      }

      // Fetch canonical metadata (mocked for now)
      const canonicalMetadata = await metadataService.getCanonicalMetadata(audioFileId);

      // Parse current tags
      let currentTags: Record<string, any> = {};
      if (file.tagsRaw) {
        const tagsData = file.tagsRaw;
        if (typeof tagsData === 'string') {
          currentTags = JSON.parse(tagsData);
        } else if (typeof tagsData === 'object') {
          currentTags = tagsData as Record<string, any>;
        }
      }

      // Compute diffs for this file
      const diffs: TagDiffEntry[] = [];
      let fileTouched = false;

      for (const field of Object.keys(canonicalMetadata) as (keyof typeof canonicalMetadata)[]) {
        const beforeValue = currentTags[field] ?? null;
        const canonicalValue = canonicalMetadata[field] ?? null;
        const isLocked = false; // TODO: Check field_locks table

        const { after, reason } = applyPolicy(field, beforeValue, canonicalValue, policy, isLocked);

        if (reason === 'locked') {
          lockedFieldsRespected++;
        }

        if (after !== beforeValue) {
          diffs.push({
            field: field as any,
            before: beforeValue,
            after,
            reason: reason as any,
          });
          fieldsModified++;
          fileTouched = true;
        } else if (beforeValue !== canonicalValue) {
          // Record no-change diffs for policy:fill and policy:overwrite
          diffs.push({
            field: field as any,
            before: beforeValue,
            after,
            reason,
          });
        }
      }

      if (fileTouched) {
        filesTouched++;
      }

      // Store diffs in tag_plan_items
      if (diffs.length > 0) {
        await db.insert(tagPlanItems).values({
          tagPlanId: planId,
          audioFileId,
          before: currentTags,
          after: {} as Record<string, any>, // Will be computed when applied
          diff: diffs,
          status: 'pending',
        });
      }
    } catch (err) {
      filesSkipped.push({
        audioFileId,
        reason: 'audio_file_error',
        message: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  }

  // Update plan status and stats
  const stats: TagPlanStats = {
    filesTouched,
    fieldsModified,
    lockedFieldsRespected,
    filesSkipped,
  };

  await db
    .update(tagPlans)
    .set({
      status: 'previewed',
      stats,
    })
    .where(eq(tagPlans.id, planId));
}

