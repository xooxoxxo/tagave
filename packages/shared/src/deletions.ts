/**
 * Deleting songs and albums (0073, vault "tagave - Deleting Songs and
 * Albums"). One mode at a time, chosen in Settings › Library › Deleting:
 *
 *   mark   tagave leaves the files alone; the owner deletes them on the
 *          server with the command Library care › Deleting shows.
 *   trash  the file worker moves them into the root's .tagave-trash folder;
 *          Restore puts them back, Empty trash (or 30 days) deletes them.
 */
import { z } from 'zod';
import type { MaintenanceTaskView } from './maintenance.js';

export const DELETE_MODES = ['mark', 'trash'] as const;
export const deleteModeSchema = z.enum(DELETE_MODES);
export type DeleteMode = z.infer<typeof deleteModeSchema>;

/** Days a file stays in the trash before the daily job deletes it. */
export const TRASH_DAYS = 30;

/** The folder inside each scan root that holds its trash (skipped by every scan). */
export const TRASH_DIR = '.tagave-trash';

/** POST /libraries/:id/deletions: what to delete, in the library's mode. */
export const createDeletionsSchema = z.object({
  trackIds: z.array(z.string().uuid()).max(5000).optional(),
  albumIds: z.array(z.string().uuid()).max(500).optional(),
}).strict().refine((b) => (b.trackIds?.length ?? 0) + (b.albumIds?.length ?? 0) > 0, { message: 'Nothing to delete' });
export type CreateDeletionsRequest = z.infer<typeof createDeletionsSchema>;

/** Unmark, Restore: the files of the rows to act on. */
export const deletionFilesSchema = z.object({
  fileIds: z.array(z.string().uuid()).min(1).max(5000),
}).strict();

export const emptyTrashSchema = z.object({
  fileIds: z.array(z.string().uuid()).min(1).max(100_000),
}).strict();

export const deleteModeUpdateSchema = z.object({ mode: deleteModeSchema }).strict();

/** One row of the Deleting page: an album's deleted files, or a single song. */
export interface DeletionGroup {
  /** the album id, or the file id for a song without an album */
  key: string;
  albumId: string | null;
  title: string;
  artist: string | null;
  /** files in this row */
  fileIds: string[];
  /** the song's title when the row is one song of a larger album */
  trackTitle: string | null;
  /** the whole album (every track of it) is deleted */
  wholeAlbum: boolean;
  /** latest deletion in the row */
  createdAt: string;
  /** trash rows: on their way in or out */
  state: 'marked' | 'moving' | 'trashed' | 'restoring';
  /** the last move or restore that failed */
  error: string | null;
}

export interface DeletingView {
  mode: DeleteMode;
  /** Trash can be chosen: at least one music folder is writable (the setting and the worker's check) */
  trashAvailable: boolean;
  marked: DeletionGroup[];
  trash: DeletionGroup[];
  /** Deletes exactly the marked files on the computer that holds the music; null when nothing is marked */
  command: string | null;
  trashDays: number;
  emptyFileIds?: string[];
  emptyTask?: { task: MaintenanceTaskView; fileIds: string[] };
}

export interface CreateDeletionsResult {
  marked: number;
  trashed: number;
}
