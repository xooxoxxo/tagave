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
  writable: z.boolean().describe('Whether tag writes are permitted on this root'),
  enabled: z.boolean().describe('Whether scans will visit this root'),
  pollIntervalS: z.number().int().positive().describe('Polling interval in seconds (default 6 hours = 21600)'),
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
