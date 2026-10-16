import { z } from 'zod';

/**
 * Settings › Backups: database dumps in the backups folder, the nightly
 * schedule and how many are kept.
 */
export const backupKindSchema = z.enum(['nightly', 'manual', 'pre-migration', 'pre-restore']);
export type BackupKindView = z.infer<typeof backupKindSchema>;

export const backupEntrySchema = z.object({
  name: z.string(),
  kind: backupKindSchema,
  createdAt: z.string(),
  bytes: z.number().int(),
  verified: z.boolean().nullable().describe('Read back with pg_restore when written; null when there is no record'),
}).strict();
export type BackupEntryView = z.infer<typeof backupEntrySchema>;

export const backupSettingsSchema = z.object({
  enabled: z.boolean(),
  hour: z.number().int().min(0).max(23),
  keepDaily: z.number().int().min(1).max(90),
  keepWeekly: z.number().int().min(0).max(52),
  /** Before-update dumps to keep (the app's before it migrates, and the updater's); at least 2. */
  keepPreUpdate: z.number().int().min(1).max(50),
  /** Manual dumps to keep; null keeps them until the owner deletes them. */
  keepManual: z.number().int().min(1).max(100).nullable(),
}).strict();
export type BackupSettingsView = z.infer<typeof backupSettingsSchema>;

export const backupRunSchema = z.object({
  kind: backupKindSchema,
  startedAt: z.string(),
  finishedAt: z.string(),
  ok: z.boolean(),
  file: z.string().nullable(),
  error: z.string().nullable(),
  pruned: z.array(z.string()),
}).strict();
export type BackupRunView = z.infer<typeof backupRunSchema>;

/** One block on Settings › Backups: a kind with its count, size and what its next run deletes. */
export const backupKindSummarySchema = z.object({
  kind: backupKindSchema,
  count: z.number().int(),
  bytes: z.number().int(),
  newest: z.string().nullable(),
  /** What the next run of this kind deletes under the saved settings (a lowered number deletes nothing on save). */
  pendingDelete: z.object({ count: z.number().int(), bytes: z.number().int(), names: z.array(z.string()) }).strict(),
}).strict();
export type BackupKindSummaryView = z.infer<typeof backupKindSummarySchema>;

export const backupsStatusSchema = z.object({
  /** The folder inside the app container (or on this machine for a source install). */
  dir: z.string(),
  /** True when the folder is the dedicated backups mount rather than a fallback inside the cache. */
  dedicated: z.boolean(),
  timeZone: z.string(),
  settings: backupSettingsSchema,
  running: z.boolean(),
  lastRun: backupRunSchema.nullable(),
  lastNightly: backupRunSchema.nullable(),
  backups: z.array(backupEntrySchema),
  /** Nightly, before update and manual always; before restore only when there is one. */
  kinds: z.array(backupKindSummarySchema),
  totalBytes: z.number().int(),
  error: z.string().nullable().describe('Why the folder could not be read'),
}).strict();
export type BackupsStatus = z.infer<typeof backupsStatusSchema>;
