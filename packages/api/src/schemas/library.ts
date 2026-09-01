// Re-export schemas from shared
export {
  librarySchema as LibrarySchema,
  scanRootSchema as ScanRootSchema,
  scanStatsSchema as ScanStatsSchema,
} from '@liner/shared/library';

export type {
  Library,
  ScanRoot,
  ScanStats,
} from '@liner/shared/library';

// Local schemas for create/patch operations
import { z } from 'zod';

export const CreateLibrarySchema = z.object({
  name: z.string().min(1).max(255),
});

export type CreateLibrary = z.infer<typeof CreateLibrarySchema>;

export const createScanRootSchema = z.object({
  path: z.string().min(1),
  displayName: z.string().min(1).max(255),
  pollIntervalS: z.number().positive().optional().default(21600),
});

export type CreateScanRoot = z.infer<typeof createScanRootSchema>;

export const patchScanRootSchema = z.object({
  displayName: z.string().min(1).max(255).optional(),
  enabled: z.boolean().optional(),
  pollIntervalS: z.number().positive().optional(),
});

export type PatchScanRoot = z.infer<typeof patchScanRootSchema>;
