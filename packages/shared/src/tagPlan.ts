import { z } from 'zod';
import { canonicalFieldSchema } from './tags.js';

/**
 * Tag plan scope — defines which files the plan applies to.
 * Per Spec §9.5 TAG-2: A plan is created with a scope (library, artist,
 * album selection, or a filter query) and a policy.
 */
export const tagPlanScopeSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('library').describe('Apply to entire library'),
  }).strict(),
  z.object({
    type: z.literal('artist').describe('Apply to all albums by an artist'),
    artistId: z.string().uuid().describe('Artist ID (global canonical artist)'),
  }).strict(),
  z.object({
    type: z.literal('albumIds').describe('Apply to specific albums'),
    albumIds: z.array(z.string().uuid()).min(1).describe('Album IDs (local albums)'),
  }).strict(),
  z.object({
    type: z.literal('filterQuery').describe('Apply to albums matching a filter query'),
    filterQuery: z.record(z.any()).describe('Filter query object (same shape as GET /albums query)'),
  }).strict(),
  z.object({
    type: z.literal('folder').describe('Apply to every file in a folder and its subfolders, whichever album it belongs to'),
    dirPath: z.string().min(1).describe('Folder relative to its scan root, as album dir_paths show it'),
    scanRootId: z.string().uuid().optional().describe('Scan root holding the folder; any root when omitted'),
  }).strict(),
]).describe('Scope of the plan: what files it applies to');

export type TagPlanScope = z.infer<typeof tagPlanScopeSchema>;

/**
 * Policy preset names per M2 Tag Correction Plan section 1 Q5.
 * Each preset defines which fields to overwrite, fill, or never touch.
 */
export const tagPolicyPresetSchema = z.enum([
  'canonical_ids_and_fill',
  'fill_blanks_only',
  'overwrite_all',
  'custom',
  'manual',
  'revert',
]).describe('Policy preset name; manual writes the values the owner typed (policy.values), identified or not; revert is built from the journal of an applied plan and restores its before-values');

export type TagPolicyPreset = z.infer<typeof tagPolicyPresetSchema>;

/**
 * Per-field policy override — specifies the behavior for a single field.
 * Used to customize a preset.
 */
export const tagFieldPolicySchema = z.enum([
  'overwrite',
  'fill',
  'never',
]).describe('Policy for a field: overwrite (always set), fill (set if blank), never (do not touch)');

export type TagFieldPolicy = z.infer<typeof tagFieldPolicySchema>;

/**
 * Fields the manual bulk editor may set for every file in a selection. The
 * album-level ones are the point; per-track artist is only written when the
 * owner explicitly chooses it. Values are what goes into the tag: strings, a
 * list for genre, and '1' / '0' for the compilation flag.
 */
export const MANUAL_TAG_FIELDS = ['albumartist', 'album', 'date', 'compilation', 'genre', 'artist'] as const;
export type ManualTagField = typeof MANUAL_TAG_FIELDS[number];

export const manualTagValuesSchema = z.object({
  albumartist: z.string().trim().min(1).max(255).optional(),
  album: z.string().trim().min(1).max(255).optional(),
  date: z.string().trim().regex(/^\d{4}(-\d{2}(-\d{2})?)?$/, 'Use YYYY, YYYY-MM or YYYY-MM-DD').optional(),
  compilation: z.enum(['1', '0']).optional(),
  genre: z.array(z.string().trim().min(1).max(100)).min(1).max(20).optional(),
  artist: z.string().trim().min(1).max(255).optional(),
}).strict().describe('Values a manual plan writes to every file in scope; a field left out is not touched');

export type ManualTagValues = z.infer<typeof manualTagValuesSchema>;

/**
 * Tag write policy — controls which fields are updated and how.
 * Per Spec §9.5 TAG-2: A plan is created with a policy: fill blanks only,
 * overwrite with canonical, or per-field rules.
 */
export const tagPoliciesSchema = z.object({
  preset: tagPolicyPresetSchema.describe('Base preset to build from'),
  id3Version: z.enum(['2.3', '2.4']).default('2.4').describe('ID3 version for MP3 files (default v2.4 UTF-8)'),
  multiValueSeparator: z.string().default('; ').describe('Separator for multi-value fields in ID3v2.3 (default "; ")'),
  overrides: z.record(canonicalFieldSchema, tagFieldPolicySchema).optional().describe('Per-field policy overrides'),
  values: manualTagValuesSchema.optional().describe('Manual preset only: the values to write'),
  revertOf: z.string().uuid().optional().describe('Revert preset only: the plan whose writes this plan undoes'),
}).strict().describe('Write policy: preset + per-field overrides');

export type TagPolicies = z.infer<typeof tagPoliciesSchema>;

/**
 * A per-file diff entry — records what will change for one audio file.
 * Per Spec §9.5 TAG-3: A plan produces a per-file diff (field, before, after,
 * reason/source) and an aggregate summary.
 */
export const tagDiffEntrySchema = z.object({
  field: canonicalFieldSchema.describe('Canonical field name'),
  before: z.union([z.string(), z.array(z.string()), z.null()]).describe('Current value (null if not set)'),
  after: z.union([z.string(), z.array(z.string()), z.null()]).describe('New value (null if will not be set)'),
  reason: z.enum(['policy:overwrite', 'policy:fill', 'locked', 'no-change', 'revert']).describe('Why this change (or lack thereof); revert restores the journalled before-value, and a null after removes the tag'),
}).strict().describe('Per-file diff for one field');

export type TagDiffEntry = z.infer<typeof tagDiffEntrySchema>;

/**
 * Summary of files that were skipped with a reason.
 * Used in the aggregate summary when a file cannot be updated.
 */
export const tagPlanSkippedFileSchema = z.object({
  audioFileId: z.string().uuid().describe('Audio file ID'),
  reason: z.enum([
    'scan_root_not_writable',
    'audio_file_error',
    'album_not_identified',
    'not_in_album',
    'release_missing',
  ]).describe('Why the file was skipped'),
  message: z.string().optional().describe('Additional error details'),
  localAlbumId: z.string().uuid().optional().describe('Album the file belongs to, so the page can offer to identify it'),
}).strict().describe('Skipped file with reason');

export type TagPlanSkippedFile = z.infer<typeof tagPlanSkippedFileSchema>;

/**
 * Aggregate summary of a plan preview — statistics and skipped files.
 * Per Spec §9.5 TAG-3: an aggregate summary (files touched, fields by count,
 * locked fields respected, files skipped and why).
 */
export const tagPlanStatsSchema = z.object({
  filesTouched: z.number().int().nonnegative().default(0).describe('Number of files with at least one change'),
  fieldsModified: z.number().int().nonnegative().default(0).describe('Total number of field changes across all files'),
  lockedFieldsRespected: z.number().int().nonnegative().default(0).describe('Number of field changes blocked by locks'),
  filesSkipped: z.array(tagPlanSkippedFileSchema).default([]).describe('Files that could not be processed'),
  filesInScope: z.number().int().nonnegative().optional().describe('Files the preview looked at'),
  filesAlreadyCorrect: z.number().int().nonnegative().optional().describe('Files compared that already carry every value the policy would write'),
  filesLockedOnly: z.number().int().nonnegative().optional().describe('Files whose only would-be changes are blocked by locks'),
  lastError: z.string().optional().describe('Why the last apply run stopped before finishing; set when the worker parks a plan as paused'),
  albumsBefore: z.number().int().nonnegative().optional().describe('Different albums that held the files to write when the first apply run started'),
}).strict().describe('Aggregate summary of a plan preview');

export type TagPlanStats = z.infer<typeof tagPlanStatsSchema>;

/**
 * Tag plan — specifies what changes to make to audio file tags.
 * Returned by GET /api/v1/libraries/:libraryId/tag-plans/:planId
 */
export const tagPlanSchema = z.object({
  id: z.string().uuid().describe('Tag plan ID (UUIDv7)'),
  libraryId: z.string().uuid().describe('Library ID'),
  name: z.string().describe('User-friendly plan name'),
  nameByUser: z.boolean().optional().describe('The owner renamed the plan; the name is never rewritten automatically'),
  scope: tagPlanScopeSchema.describe('Scope: which files this applies to'),
  scopeLabel: z.string().optional().describe('Human-readable scope (artist name, album count); resolved by the API on list and detail'),
  policy: tagPoliciesSchema.describe('Write policy'),
  status: z.enum([
    'draft',
    'previewed',
    'applying',
    'paused',
    'cancelled',
    'applied',
    'partially_failed',
    'reverted',
  ]).describe('Current status of the plan'),
  stats: tagPlanStatsSchema.optional().describe('Aggregate summary (populated after preview)'),
  createdBy: z.string().uuid().describe('User ID who created the plan'),
  createdAt: z.string().datetime().describe('ISO 8601 creation timestamp'),
  appliedAt: z.string().datetime().optional().describe('ISO 8601 timestamp when plan was fully or partially applied'),
  formats: z.array(z.string()).optional().describe('Distinct lower-case file extensions of the files in the plan (detail only, once previewed): the ID3 version matters only when one is an ID3 format'),
  progress: z.record(z.string(), z.number()).optional().describe('Item counts by status (applied, failed, …); on the detail, and on list rows whose apply finished with failures'),
}).strict().describe('A tag correction plan');

export type TagPlan = z.infer<typeof tagPlanSchema>;

/**
 * The latest preview job of a draft plan, as GET /tag-plans/:planId reports
 * it: the queue's view (queued / running / done) joined with the worker's
 * job_runs row (what it is doing, files done). jobRunId is the id the
 * Background activity page knows the job by.
 */
export const tagPlanPreviewJobSchema = z.object({
  jobId: z.string().describe('Queue job id, as POST /preview returns it'),
  state: z.enum(['queued', 'running', 'completed', 'failed']),
  queuedAt: z.string().datetime(),
  startedAt: z.string().datetime().optional(),
  finishedAt: z.string().datetime().optional(),
  jobRunId: z.string().uuid().optional(),
  message: z.string().optional(),
  done: z.number().int().nonnegative().optional(),
  total: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
}).strict();

export type TagPlanPreviewJob = z.infer<typeof tagPlanPreviewJobSchema>;

/**
 * Create tag plan request.
 * Body for POST /api/v1/libraries/:libraryId/tag-plans
 */
export const createTagPlanSchema = z.object({
  name: z.string().min(1).describe('User-friendly plan name'),
  scope: tagPlanScopeSchema.describe('Scope: which files this applies to'),
  policy: tagPoliciesSchema.describe('Write policy'),
}).strict().describe('Create a new tag plan');

export type CreateTagPlan = z.infer<typeof createTagPlanSchema>;

/** Longest plan name the database holds (tag_plans.name varchar(255)). */
export const TAG_PLAN_NAME_MAX = 255;

/**
 * Rename a plan. Body for PATCH /api/v1/libraries/:libraryId/tag-plans/:planId.
 * The name is trimmed; blank is refused. A name set here is the owner's and
 * is never rewritten automatically afterwards.
 */
export const renameTagPlanSchema = z.object({
  name: z.string()
    .transform((s) => s.replace(/\s+/g, ' ').trim())
    .pipe(z.string().min(1, 'The name cannot be empty').max(TAG_PLAN_NAME_MAX, `The name can be at most ${TAG_PLAN_NAME_MAX} characters`)),
}).strict().describe('Rename a tag plan');

export type RenameTagPlan = z.infer<typeof renameTagPlanSchema>;

/**
 * One album that holds files a plan wrote, as it stands now (after the
 * worker re-clustered the folders the plan touched).
 */
export const tagPlanResultAlbumSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  artistCredit: z.string(),
  /** canonical artist to link to; null when the artist is known only from tags */
  artistId: z.string().uuid().nullable(),
  year: z.number().int().nullable(),
  coverUrl: z.string().nullable(),
  trackCount: z.number().int().nonnegative(),
  /** files of this plan that now sit in this album */
  planFiles: z.number().int().nonnegative(),
}).strict();

export type TagPlanResultAlbum = z.infer<typeof tagPlanResultAlbumSchema>;

/**
 * What an applied plan left behind. GET /tag-plans/:planId/results.
 * `updating` is true while the worker is still re-clustering the plan's
 * folders; the albums are then those of before the re-cluster.
 */
export const tagPlanResultsSchema = z.object({
  filesWritten: z.number().int().nonnegative(),
  filesFailed: z.number().int().nonnegative(),
  /**
   * how many different albums held the plan's files when it started writing
   * (recorded by tags.apply); null for plans applied before it was recorded
   */
  albumsBefore: z.number().int().nonnegative().nullable(),
  /** how many albums hold the plan's written files now; `albums` lists at most the first 60 */
  albumCount: z.number().int().nonnegative(),
  albums: z.array(tagPlanResultAlbumSchema),
  /** written files that belong to no album */
  looseFiles: z.number().int().nonnegative(),
  updating: z.boolean(),
}).strict();

export type TagPlanResults = z.infer<typeof tagPlanResultsSchema>;

/**
 * Tag plan item — a per-file diff entry in a plan.
 * Returned by GET /api/v1/libraries/:libraryId/tag-plans/:planId/items
 */
export const tagPlanItemSchema = z.object({
  id: z.string().uuid().describe('Item ID'),
  planId: z.string().uuid().describe('Tag plan ID'),
  audioFileId: z.string().uuid().describe('Audio file ID'),
  relPath: z.string().optional().describe('Path of the file relative to its scan root (for the preview table)'),
  status: z.enum(['pending', 'applying', 'applied', 'failed', 'skipped']).optional().describe('Write state of this file within the plan'),
  error: z.string().optional().describe('Why the write failed or was skipped'),
  diffs: z.array(tagDiffEntrySchema).describe('List of field changes for this file'),
}).strict().describe('Per-file diffs in a tag plan');

export type TagPlanItem = z.infer<typeof tagPlanItemSchema>;
