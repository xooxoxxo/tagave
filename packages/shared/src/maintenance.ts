import { z } from 'zod';

export const MAINTENANCE_KINDS = ['cover', 'split', 'empty-trash', 'flac-upgrade'] as const;
export type MaintenanceKind = typeof MAINTENANCE_KINDS[number];
export const maintenanceTaskSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(MAINTENANCE_KINDS),
  subjectId: z.string().uuid().nullable(),
  state: z.enum(['waiting', 'running', 'interrupted', 'review', 'done', 'failed', 'cancelled']),
  stage: z.string(),
  progress: z.object({ done: z.number(), total: z.number() }).nullable(),
  error: z.string().nullable(),
  attempt: z.number(),
  updatedAt: z.string().datetime(),
  cancelRequested: z.boolean(),
  workerAvailable: z.boolean(),
  actions: z.array(z.enum(['retry', 'continue', 'cancel', 'restore-original'])),
}).strict();

export type MaintenanceTaskView = z.infer<typeof maintenanceTaskSchema>;
export type MaintenanceState = MaintenanceTaskView['state'];
export type MaintenanceProgress = NonNullable<MaintenanceTaskView['progress']>;

export const MAINTENANCE_LABELS: Record<MaintenanceKind, string> = {
  cover: 'Cover art lookup',
  split: 'Split album',
  'empty-trash': 'Empty Trash',
  'flac-upgrade': 'Upgrade to FLAC',
};

export interface FlacUpgradeView {
  eligible: boolean;
  task: MaintenanceTaskView | null;
}
