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
]).describe('Policy preset name');

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
 * Tag write policy — controls which fields are updated and how.
 * Per Spec §9.5 TAG-2: A plan is created with a policy: fill blanks only,
 * overwrite with canonical, or per-field rules.
 */
export const tagPoliciesSchema = z.object({
  preset: tagPolicyPresetSchema.describe('Base preset to build from'),
  id3Version: z.enum(['2.3', '2.4']).default('2.4').describe('ID3 version for MP3 files (default v2.4 UTF-8)'),
  multiValueSeparator: z.string().default('; ').describe('Separator for multi-value fields in ID3v2.3 (default "; ")'),
  overrides: z.record(canonicalFieldSchema, tagFieldPolicySchema).optional().describe('Per-field policy overrides'),
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
  reason: z.enum(['policy:overwrite', 'policy:fill', 'locked', 'no-change']).describe('Why this change (or lack thereof)'),
}).strict().describe('Per-file diff for one field');

export type TagDiffEntry = z.infer<typeof tagDiffEntrySchema>;

/**
 * Summary of files that were skipped with a reason.
 * Used in the aggregate summary when a file cannot be updated.
 */
export const tagPlanSkippedFileSchema = z.object({
  audioFileId: z.string().uuid().describe('Audio file ID'),
  reason: z.enum(['scan_root_not_writable', 'audio_file_error']).describe('Why the file was skipped'),
  message: z.string().optional().describe('Additional error details'),
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
  lastError: z.string().optional().describe('Why the last apply run stopped before finishing; set when the worker parks a plan as paused'),
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
}).strict().describe('A tag correction plan');

export type TagPlan = z.infer<typeof tagPlanSchema>;

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
