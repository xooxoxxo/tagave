import { z } from 'zod';

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
  lastStatus: z.string().optional().describe('Status of the last scan'),
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
 * Library settings view per PLT-4 (token configuration) and XO-310 (genres)
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
}).strict();

export type LibrarySettingsView = z.infer<typeof librarySettingsViewSchema>;

/**
 * Library settings patch request per PLT-4 and XO-310
 * Body for PATCH /libraries/:id/settings
 */
export const patchLibrarySettingsSchema = z.object({
  contactString: z.string().min(3).optional().describe('Contact info for Discogs requests'),
  discogsToken: z.union([z.string().min(10), z.null()]).optional().describe('Discogs API token (null to clear)'),
  acoustidKey: z.union([z.string().min(8), z.null()]).optional().describe('AcoustID key (null to clear)'),
  onboardingCompletedAt: z.string().datetime().nullable().optional().describe('ISO 8601 timestamp when onboarding was completed'),
  genreMap: genreMapSchema.optional().describe('Genre canonicalisation configuration'),
}).strict();

export type PatchLibrarySettings = z.infer<typeof patchLibrarySettingsSchema>;
