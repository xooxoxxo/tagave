import { z } from 'zod';
import { tagPoliciesSchema } from './tagPlan.js';

/**
 * Scan root configuration per LIB-1
 * Each root represents a mounted path where audio files are stored
 */
export const scanRootSchema = z.object({
  id: z.string().uuid().describe('Scan root ID (UUIDv7)'),
  libraryId: z.string().uuid(),
  path: z.string().describe('Absolute path inside the container'),
  displayName: z.string().describe('Human-readable name for the scan root'),
  writable: z.boolean().describe('Whether tag writes are permitted on this root (owner intent)'),
  enabled: z.boolean().describe('Whether scans will visit this root'),
  pollIntervalS: z.number().int().positive().describe('Polling interval in seconds (default 6 hours = 21600)'),
  validationStatus: z.enum(['pending', 'ok', 'missing', 'not_directory', 'unreadable']).describe('Validation status from the worker (LIB-1)'),
  validationMessage: z.string().nullable().optional().describe('Details if validation failed or mount is read-only'),
  validatedAt: z.string().datetime().nullable().optional().describe('ISO 8601 timestamp of last validation'),
  probeWritable: z.boolean().nullable().optional().describe('Observed write ability on the worker host'),
  lastScanAt: z.string().datetime().optional().describe('ISO 8601 timestamp of the last completed scan'),
  lastStatus: z.string().nullable().optional().describe('Status of the last scan; null until the first scan'),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();

export type ScanRoot = z.infer<typeof scanRootSchema>;

/**
 * Create scan root request
 */
export const createScanRootSchema = z.object({
  path: z.string().describe('Absolute path inside the container'),
  displayName: z.string().describe('Human-readable name for the scan root'),
  writable: z.boolean().default(true).describe('Whether tag writes are permitted on this root'),
  enabled: z.boolean().default(true).describe('Whether scans will visit this root'),
  pollIntervalS: z.number().int().positive().default(21600).describe('Polling interval in seconds (default 6 hours)'),
}).strict();

export type CreateScanRootRequest = z.infer<typeof createScanRootSchema>;

/**
 * Patch scan root request
 */
export const patchScanRootSchema = z.object({
  displayName: z.string().optional(),
  writable: z.boolean().optional(),
  enabled: z.boolean().optional(),
  pollIntervalS: z.number().int().positive().optional(),
}).strict();

export type PatchScanRootRequest = z.infer<typeof patchScanRootSchema>;

/**
 * Library configuration per Section 11.1
 * In v1, there is one library per owner
 */
export const librarySchema = z.object({
  id: z.string().uuid().describe('Library ID (UUIDv7)'),
  ownerUserId: z.string().uuid(),
  name: z.string().describe('User-friendly library name'),
  settings: z.record(z.any()).optional().describe('Settings stored as JSON (see spec Section 12.8)'),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();

export type Library = z.infer<typeof librarySchema>;

/**
 * Scan statistics per LIB-7
 * Reported after each scan completes
 */
export const scanStatsSchema = z.object({
  filesSeen: z.number().int().nonnegative().describe('Total files visited'),
  filesAdded: z.number().int().nonnegative().describe('New files added'),
  filesChanged: z.number().int().nonnegative().describe('Files with changed size or mtime'),
  filesMissing: z.number().int().nonnegative().describe('Previously indexed files no longer found'),
  filesErrored: z.number().int().nonnegative().describe('Files that failed to parse'),
  formats: z.record(z.number()).optional().describe('Breakdown by audio format (container type)'),
  elapsedMs: z.number().int().nonnegative().optional().describe('Scan duration in milliseconds'),
  throughputFilesPerSecond: z.number().positive().optional().describe('Average files per second'),
}).strict();

export type ScanStats = z.infer<typeof scanStatsSchema>;

/**
 * Genre map configuration per XO-310
 * Whitelist of canonical genres and aliases for tag normalization
 */
export const genreMapSchema = z.object({
  whitelist: z.array(z.string().min(1)).max(100).describe('List of canonical genre names'),
  aliases: z.record(z.string().min(1)).default({}).describe('Mapping of tags to canonical genres (lower-case keys)'),
  maxGenres: z.number().int().min(1).max(10).describe('Maximum number of genres to return'),
}).strict();

export type GenreMap = z.infer<typeof genreMapSchema>;

/**
 * Follow rules configuration per XO-301 GAP-2
 * Determines which MusicBrainz release groups are followed and tracked
 */
export const followRulesSchema = z.object({
  includePrimary: z.array(z.enum(['Album', 'EP', 'Single'])).default(['Album']).describe('Primary release types to include (Album, EP, Single)'),
  excludeSecondary: z.array(z.enum(['Compilation', 'Live', 'Remix', 'DJ-mix', 'Mixtape/Street', 'Demo', 'Soundtrack'])).default(['Compilation', 'Live', 'Remix', 'DJ-mix', 'Mixtape/Street', 'Demo', 'Soundtrack']).describe('Secondary types to exclude'),
  autoFollowMinAlbums: z.number().int().min(1).max(10).default(2).describe('Minimum albums by artist to auto-follow (1–10)'),
}).strict();

export type FollowRules = z.infer<typeof followRulesSchema>;

/**
 * Lint rules configuration per TAG-6
 * Toggle individual quality rules on or off (all true by default)
 */
export const lintRulesSchema = z.object({
  inconsistentAlbumFields: z.boolean().default(true).describe('Flag inconsistent album/albumartist/date/totaltracks'),
  missingMbIds: z.boolean().default(true).describe('Flag tracks missing MusicBrainz recording or release-track IDs'),
  trackNumberIssues: z.boolean().default(true).describe('Flag missing or duplicate track numbers'),
  titleCaseAnomalies: z.boolean().default(true).describe('Flag title case issues (all lowercase or ALL CAPS)'),
  emptyRequiredFields: z.boolean().default(true).describe('Flag empty required fields (title, artist, album, tracknumber)'),
  discNumberGaps: z.boolean().default(true).describe('Flag disc number gaps'),
  noEmbeddedArt: z.boolean().default(true).describe('Flag albums with no embedded art'),
}).strict();

export type LintRules = z.infer<typeof lintRulesSchema>;

/**
 * Library settings view per PLT-4 (token configuration) and XO-310 (genres) and TAG-6 (lint rules) and XO-301 (discography)
 * Returned by GET /libraries/:id/settings
 */
export const librarySettingsViewSchema = z.object({
  contactString: z.string().nullable().describe('Contact info for Discogs requests'),
  discogsTokenSet: z.boolean().describe('Whether a Discogs token is configured'),
  discogsTokenHint: z.string().nullable().describe('Last 4 characters of the Discogs token for hint purposes'),
  acoustidKeySet: z.boolean().describe('Whether an AcoustID key is configured'),
  acoustidKeyHint: z.string().nullable().describe('Last 4 characters of the AcoustID key for hint purposes'),
  onboardingCompletedAt: z.string().datetime().nullable().describe('ISO 8601 timestamp when onboarding was completed'),
  genreMap: genreMapSchema.describe('Genre canonicalisation configuration (required)'),
  lintRules: lintRulesSchema.describe('Lint rule toggles (TAG-6; defaults all true)'),
  tagPolicy: tagPoliciesSchema.optional().describe('Tag write policy (preset + per-field overrides)'),
  tagWritesEnabled: z.boolean().default(false).describe('Whether tag writes are enabled (default false per spec §12.8)'),
  discographyRefreshEnabled: z.boolean().default(false).describe('Whether weekly discography refreshes are enabled (XO-301; default false)'),
  followRules: followRulesSchema.describe('Rules for following artists and filtering release groups (XO-301 GAP-2; defaults provided)'),
  fingerprintingEnabled: z.boolean().default(false).describe('IDN-5: fingerprint unidentified albums and look them up on AcoustID (needs the key; default false)'),
}).strict();

export type LibrarySettingsView = z.infer<typeof librarySettingsViewSchema>;

/**
 * Library settings patch request per PLT-4, XO-310, TAG-6, and XO-301
 * Body for PATCH /libraries/:id/settings
 */
export const patchLibrarySettingsSchema = z.object({
  contactString: z.string().min(3).optional().describe('Contact info for Discogs requests'),
  discogsToken: z.union([z.string().min(10), z.null()]).optional().describe('Discogs API token (null to clear)'),
  acoustidKey: z.union([z.string().min(8), z.null()]).optional().describe('AcoustID key (null to clear)'),
  onboardingCompletedAt: z.string().datetime().nullable().optional().describe('ISO 8601 timestamp when onboarding was completed'),
  genreMap: genreMapSchema.optional().describe('Genre canonicalisation configuration'),
  lintRules: lintRulesSchema.optional().describe('Lint rule toggles (TAG-6)'),
  tagPolicy: tagPoliciesSchema.optional().describe('Tag write policy (preset + per-field overrides)'),
  tagWritesEnabled: z.boolean().default(false).optional().describe('Whether tag writes are enabled (default false per spec §12.8)'),
  discographyRefreshEnabled: z.boolean().optional().describe('Whether weekly discography refreshes are enabled (XO-301)'),
  followRules: followRulesSchema.optional().describe('Rules for following artists and filtering release groups (XO-301)'),
  fingerprintingEnabled: z.boolean().optional().describe('IDN-5: fingerprint unidentified albums and look them up on AcoustID'),
}).strict();

export type PatchLibrarySettings = z.infer<typeof patchLibrarySettingsSchema>;
